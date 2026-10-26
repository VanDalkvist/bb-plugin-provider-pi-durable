import { DeltaTranslator } from "./delta-translator.ts";
import { SubagentMirrorManager, type SubagentMirrorRecord } from "./subagent-mirror.ts";
import { spawnSubthreadInBb } from "./subthread-spawner.ts";
import type { RunnerEvent, SessionOptions } from "./types.ts";

export interface SubagentSessionContext {
	options: SessionOptions;
	getThreadIdForConversation(conversationId: string | number): string | undefined;
	registerThread(threadId: string, conversationId?: string): void;
}

export class SessionSubagentHandler {
	private mirrors = new SubagentMirrorManager();
	private childTranslators = new Map<string, DeltaTranslator>();

	public getChildTranslator(threadId: string): DeltaTranslator {
		let t = this.childTranslators.get(threadId);
		if (!t) {
			t = new DeltaTranslator();
			this.childTranslators.set(threadId, t);
		}
		return t;
	}

	public unregisterChild(threadId: string): void {
		this.childTranslators.delete(threadId);
	}

	public markActive(id: string | number, meta: { task: string; parentToolCallId?: string; actualModel?: { provider: string; modelId: string }; thinkingLevel?: string; source?: "inherit" | "configured"; policyRevision?: number }): void {
		this.mirrors.markActive(id, meta);
	}

	public markInitialConsumed(id: string | number): void { this.mirrors.markInitialTurnConsumed(id); }

	public markCompleted(id: string | number, result?: string): void {
		this.mirrors.markCompleted(id, result);
	}

	public consumeCompleted(id: string | number): void {
		this.mirrors.consumeCompleted(id);
	}

	public findConversationForTask(task: string): string | undefined {
		return this.mirrors.findConversationForTask(task);
	}

	public getState(id: string | number): SubagentMirrorRecord | undefined {
		return this.mirrors.getState(id);
	}

	public getOutputText(id: string | number): string {
		return this.mirrors.getOutputText(id);
	}

	public flushBufferedDeltas(
		conversationId: string | number,
		threadId: string,
		options: { cwd?: string; providerOptions?: Record<string, unknown> },
		sendNotification: (method: string, params: Record<string, unknown>) => void,
	): boolean {
		const translator = this.getChildTranslator(threadId);
		return this.mirrors.flushBufferedDeltas(
			conversationId,
			translator,
			{ threadId, cwd: options.cwd, providerOptions: options.providerOptions },
			(tid, deltas) => sendNotification("thread/delta", { threadId: tid, deltas }),
		);
	}

	public handleEvent(
		event: RunnerEvent,
		session: SubagentSessionContext,
		sendNotification: (method: string, params: Record<string, unknown>) => void,
	): boolean {
		if (event.type === "tool_execution_update" && event.details && typeof event.details === "object") {
			const details = event.details as Record<string, unknown>;
			if (details.conversationId !== undefined) {
				const task = typeof details.task === "string" ? details.task : "";
				const parentToolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
				const convId = String(details.conversationId);
				const isNew = !this.getState(convId);
				const actualModel = details.actualModel && typeof details.actualModel === "object"
					? (details.actualModel as { provider: string; modelId: string })
					: undefined;
				const thinkingLevel = typeof details.thinkingLevel === "string" ? details.thinkingLevel : undefined;
				const source = details.source === "configured" || details.source === "inherit" ? details.source : undefined;
				const policyRevision = typeof details.policyRevision === "number" ? details.policyRevision : undefined;

				this.markActive(convId, { task, parentToolCallId, actualModel, thinkingLevel, source, policyRevision });
				if (isNew && task) {
					void spawnSubthreadInBb({
						parentThreadId: session.options.threadId,
						environmentId: session.options.environmentId || process.env.BB_ENVIRONMENT_ID,
						title: task.trim().slice(0, 80) || "Subagent",
						task,
						conversationId: convId,
						actualModel,
						thinkingLevel,
					}, session);
				}
			}
		}

		if (event.type === "tool_execution_end" && event.details && typeof event.details === "object") {
			const details = event.details as Record<string, unknown>;
			if (details.conversationId !== undefined && details.background !== true) {
				const result = typeof event.result === "string" ? event.result : undefined;
				this.markCompleted(details.conversationId as string | number, result);
			}
		}

		if (event.type === "runtime_graph_snapshot" && !event.conversationId) {
			const rootId = String((event.snapshot as any)?.scope?.rootConversationId ?? "1");
			const convKeys = new Set<string>([
				...Object.keys((event.snapshot as any)?.conversations ?? {}),
				...this.mirrors.getConversationIds(),
			]);
			for (const cid of convKeys) {
				if (cid === rootId) continue;
				const childThreadId = session.getThreadIdForConversation(cid);
				const childEvent = { ...event, conversationId: cid, parentRef: undefined };
				if (childThreadId) {
					const childTranslator = this.getChildTranslator(childThreadId);
					const childDeltas = childTranslator.translate(childEvent, {
						threadId: childThreadId,
						cwd: session.options.cwd,
						providerOptions: session.options.providerOptions,
					});
					if (childDeltas.length > 0) {
						sendNotification("thread/delta", { threadId: childThreadId, deltas: childDeltas });
					}
				} else if (this.mirrors.getState(cid)) {
					this.mirrors.bufferEvent(cid, childEvent);
				}
			}
			return false;
		}

		const isChildEvent = event.conversationId !== undefined && event.conversationId !== null;
		const childThreadId = isChildEvent
			? session.getThreadIdForConversation(event.conversationId as string | number)
			: undefined;

		if (isChildEvent && event.type === "message_update") {
			const asst = event.assistantMessageEvent as Record<string, unknown> | undefined;
			const textDelta = asst?.type === "text_delta" && typeof asst.delta === "string" ? asst.delta : "";
			if (textDelta) {
				this.mirrors.appendOutputText(event.conversationId as string | number, textDelta);
			}
		}

		if (childThreadId) {
			const childEvent = { ...event, parentRef: undefined };
			const childTranslator = this.getChildTranslator(childThreadId);
			const childDeltas = childTranslator.translate(childEvent, {
				threadId: childThreadId,
				cwd: session.options.cwd,
				providerOptions: session.options.providerOptions,
			});
			if (childDeltas.length > 0) {
				sendNotification("thread/delta", { threadId: childThreadId, deltas: childDeltas });
			}
			if (event.type === "agent_end") {
				this.markCompleted(event.conversationId as string | number);
			}
		} else if (isChildEvent) {
			this.mirrors.bufferEvent(event.conversationId as string | number, event);
			if (event.type === "agent_end") {
				this.markCompleted(event.conversationId as string | number);
			}
		}

		return isChildEvent && (!event.parentRef || event.type === "agent_end");
	}
}
