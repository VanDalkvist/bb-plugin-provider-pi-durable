import { RunnerProcess } from "./runner-process.ts";
import { DeltaTranslator } from "./delta-translator.ts";
import {
	buildRunnerArgs,
	createReadyDeferred,
	waitForReady,
	extractSessionStats,
	createContextWindowDelta,
	type SessionStats,
} from "./session-telemetry.ts";
import { SubagentMirrorManager, type SubagentMirrorRecord } from "./subagent-mirror.ts";
import { spawnSubthreadInBb } from "./subthread-spawner.ts";
import { DurableBindingManager } from "./durable-binding-store.ts";
import type { RunnerEvent, SessionOptions } from "./types.ts";

export type { SubagentMirrorRecord };

export class PiThreadSession {
	public options: SessionOptions;
	private sendNotification: (method: string, params: Record<string, unknown>) => void;
	public runner: RunnerProcess;
	public translator = new DeltaTranslator();
	public readyPromise: Promise<void>;
	private readyResolve: () => void;
	private readyReject: (err: Error) => void;
	public isProcessing = false;
	private lastCheckpointId: string | null = null;
	public bindings = new DurableBindingManager();
	private mirrors = new SubagentMirrorManager();
	private childTranslators = new Map<string, DeltaTranslator>();

	constructor(options: SessionOptions, sendNotification: (method: string, params: Record<string, unknown>) => void) {
		this.options = options;
		this.sendNotification = sendNotification;
		const deferred = createReadyDeferred();
		this.readyPromise = deferred.promise;
		this.readyResolve = deferred.resolve;
		this.readyReject = deferred.reject;
		this.runner = new RunnerProcess({
			cwd: options.cwd || process.cwd(),
			args: buildRunnerArgs(options),
			prompts: { scratchDir: options.scratchDir, systemPrompt: options.systemPrompt, appendSystemPrompt: options.appendSystemPrompt },
			env: options.shellEnvOverrides,
			onEvent: (event) => this.handleRunnerEvent(event),
			onChannelMessage: (msg: any) => { if (msg?.kind === "ready") this.readyResolve(); },
			onError: (err) => this.readyReject(new Error(`Runner failed to launch: ${err.message}`)),
			onExit: (code, sig) => this.readyReject(new Error(`Runner exited before becoming ready (code ${code}, signal ${sig})`)),
		});
		this.bindings.setRpc((cmd) => this.runner.requestOk(cmd));
	}

	public registerThread(threadId: string, conversationId?: string): void {
		this.bindings.register(threadId, conversationId, this.options.threadId);
		if (conversationId) {
			this.mirrors.flushBufferedDeltas(conversationId, this.getChildTranslator(threadId), {
				threadId, cwd: this.options.cwd, providerOptions: this.options.providerOptions,
			}, (tid, deltas) => this.sendNotification("thread/delta", { threadId: tid, deltas }));
		}
	}

	public unregisterThread(threadId: string): void {
		this.bindings.unregister(threadId);
		this.childTranslators.delete(threadId);
	}

	private getChildTranslator(threadId: string): DeltaTranslator {
		let t = this.childTranslators.get(threadId);
		if (!t) {
			t = new DeltaTranslator();
			this.childTranslators.set(threadId, t);
		}
		return t;
	}

	public getThreadIdForConversation(conversationId: string | number): string | undefined {
		return this.bindings.getThreadId(conversationId);
	}

	public markSubagentActive(id: string | number, meta: { task: string; parentToolCallId?: string }): void {
		this.mirrors.markActive(id, meta);
	}
	public markSubagentCompleted(id: string | number, result?: string): void { this.mirrors.markCompleted(id, result); }
	public consumeCompletedMirror(id: string | number): void { this.mirrors.consumeCompleted(id); }
	public findSubagentConversationForTask(task: string): string | undefined { return this.mirrors.findConversationForTask(task); }
	public getSubagentState(id: string | number): SubagentMirrorRecord | undefined { return this.mirrors.getState(id); }
	public getMirrorOutputText(id: string | number): string { return this.mirrors.getOutputText(id); }

	public async start(): Promise<void> {
		try {
			await waitForReady(this.readyPromise);
			await this.bindings.hydrateFromRunner();
			await this.refreshContextUsage();
		} catch (err) {
			this.kill();
			throw err;
		}
	}

	private async handleRunnerEvent(event: RunnerEvent) {
		if (typeof event.providerCheckpointId === "string" && event.providerCheckpointId.length > 0) {
			this.lastCheckpointId = event.providerCheckpointId;
		}

		if (event.type === "agent_end") {
			try {
				await this.refreshContextUsage();
			} catch (err) {
				console.warn(`[PiThreadSession] Context refresh failed before agent_end: ${err}`);
			}
		}

		if (event.type === "tool_execution_update" && event.details && typeof event.details === "object") {
			const details = event.details as Record<string, unknown>;
			if (details.conversationId !== undefined) {
				const task = typeof details.task === "string" ? details.task : "";
				const parentToolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
				const convId = String(details.conversationId);
				const isNew = !this.getSubagentState(convId);
				this.markSubagentActive(convId, { task, parentToolCallId });
				if (isNew && task) {
					void spawnSubthreadInBb({
						parentThreadId: this.options.threadId,
						environmentId: this.options.environmentId || process.env.BB_ENVIRONMENT_ID,
						title: task.trim().slice(0, 80) || "Subagent",
						task,
						conversationId: convId,
					}, this);
				}
			}
		}

		if (event.type === "tool_execution_end" && event.details && typeof event.details === "object") {
			const details = event.details as Record<string, unknown>;
			if (details.conversationId !== undefined) {
				const result = typeof event.result === "string" ? event.result : undefined;
				this.markSubagentCompleted(details.conversationId as string | number, result);
			}
		}

		const isChildEvent = event.conversationId !== undefined && event.conversationId !== null;
		const childThreadId = isChildEvent
			? this.getThreadIdForConversation(event.conversationId as string | number)
			: undefined;

		if (isChildEvent && event.type === "message_update") {
			const asst = event.assistantMessageEvent as Record<string, unknown> | undefined;
			const textDelta = asst?.type === "text_delta" && typeof asst.delta === "string"
				? asst.delta
				: "";
			if (textDelta) {
				this.mirrors.appendOutputText(event.conversationId as string | number, textDelta);
			}
		}

		if (childThreadId) {
			const childEvent = { ...event, parentRef: undefined };
			const childTranslator = this.getChildTranslator(childThreadId);
			const childDeltas = childTranslator.translate(childEvent, {
				threadId: childThreadId,
				cwd: this.options.cwd,
				providerOptions: this.options.providerOptions,
			});
			if (childDeltas.length > 0) {
				this.sendNotification("thread/delta", { threadId: childThreadId, deltas: childDeltas });
			}
			if (event.type === "agent_end") {
				this.sendNotification("thread/delta", {
					threadId: childThreadId,
					deltas: [{ kind: "turn.boundary", status: "completed" }],
				});
				this.markSubagentCompleted(event.conversationId as string | number);
			}
		} else if (isChildEvent) {
			this.mirrors.bufferEvent(event.conversationId as string | number, event);
			if (event.type === "agent_end") {
				this.markSubagentCompleted(event.conversationId as string | number);
			}
		}

		if (isChildEvent && (!event.parentRef || event.type === "agent_end")) {
			return;
		}

		const parentDeltas = this.translator.translate(event, {
			threadId: this.options.threadId,
			cwd: this.options.cwd,
			providerOptions: this.options.providerOptions,
		});
		if (parentDeltas.length > 0) {
			this.sendNotification("thread/delta", { threadId: this.options.threadId, deltas: parentDeltas });
		}

		if (event.type === "turn_end" || event.type === "compaction_end") {
			try {
				await this.refreshContextUsage();
			} catch (err) {
				console.warn(`[PiThreadSession] Context refresh failed after ${event.type}: ${err}`);
			}
		}
	}

	public async prompt(text: string, conversationId?: string): Promise<void> {
		this.isProcessing = true;
		try {
			await this.runner.requestOk({ type: "prompt", message: text, streamingBehavior: "followUp", conversationId });
		} finally {
			this.isProcessing = false;
		}
	}
	public async steer(text: string, conversationId?: string): Promise<void> {
		await this.runner.requestOk({ type: "steer", message: text, conversationId });
	}
	public async abort(conversationId?: string): Promise<void> {
		try {
			await this.runner.requestOk({ type: "abort", conversationId });
		} catch (err) {
			console.warn(`[PiThreadSession] Abort request failed: ${err}`);
		}
	}
	public async compact(instructions?: string): Promise<void> {
		this.isProcessing = true;
		try {
			await this.runner.requestOk({ type: "compact", instructions });
		} finally {
			this.isProcessing = false;
		}
	}

	public async refreshContextUsage(): Promise<void> {
		const stats = await this.getSessionStats();
		const delta = createContextWindowDelta(stats);
		if (delta) {
			this.sendNotification("thread/delta", { threadId: this.options.threadId, deltas: [delta] });
		}
	}

	public getLastCheckpointId(): string | null { return this.lastCheckpointId; }
	public async getSessionStats(): Promise<SessionStats> {
		const res = await this.runner.requestOk({ type: "get_session_stats" });
		return extractSessionStats(res);
	}
	public async closeGracefully(): Promise<void> { await this.runner.closeGracefully(); }
	public kill(): void { this.runner.kill(); }
}
