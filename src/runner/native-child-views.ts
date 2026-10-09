import { z } from "zod";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { watchEvents, type AgentEventStream, type SnapshotEvent } from "@earendil-works/pi-durable";
import { NativeChildViewCommandSchema, NativeChildViewEventSchema } from "../native-child-contract.ts";
import { inspectNativeChildIdentity } from "./native-child-inspection.ts";
import { BBEventAdapter } from "./bridge/bb-event-adapter.ts";
import type { BBWireEvent, BBAssistantMessage } from "./bridge/contracts.ts";
import type { OpenDurableResult } from "./runtime-types.ts";


const assistantSchema = z.object({
	role: z.literal("assistant"),
	content: z.array(z.discriminatedUnion("type", [
		z.object({ type: z.literal("text"), text: z.string() }),
		z.object({ type: z.literal("thinking"), thinking: z.string() }),
		z.object({ type: z.literal("toolCall"), id: z.string(), name: z.string(), arguments: z.record(z.string(), z.unknown()) }),
	])),
	stopReason: z.enum(["stop", "toolUse", "length", "aborted", "error", "pending", "deferred"]).optional(),
	usage: z.object({
		input: z.number().optional(), output: z.number().optional(), cacheRead: z.number().optional(),
		cacheWrite: z.number().optional(), totalTokens: z.number().optional(),
		cost: z.object({ input: z.number().optional(), output: z.number().optional(), cacheRead: z.number().optional(), cacheWrite: z.number().optional(), total: z.number().optional() }).optional(),
	}).optional(),
});
const toolResultSchema = z.object({
	role: z.literal("toolResult"), toolCallId: z.string(), toolName: z.string(),
	content: z.array(z.object({ type: z.literal("text"), text: z.string() })).optional(),
	isError: z.boolean().optional(),
});

export function projectNativeChildSnapshot(
	snapshot: SnapshotEvent,
	emit: (event: BBWireEvent) => void,
	terminalStatus?: "completed" | "failed" | "interrupted",
	seenEntries?: Set<number>,
	partialBlocks?: Map<number, string>,
): void {
	if (!seenEntries || seenEntries.size === 0) {
		emit({ type: "agent_start" });
		emit({ type: "turn_start" });
	}
	let last: BBAssistantMessage | undefined;
	for (const entry of snapshot.entries) {
		if (seenEntries?.has(entry.id)) continue;
		seenEntries?.add(entry.id);
		for (const model of entry.model ?? []) {
			const assistant = assistantSchema.safeParse(model);
			if (assistant.success) {
				last = assistant.data;
				for (const block of assistant.data.content) if (block.type === "toolCall") emit({ type: "tool_execution_start", toolCallId: block.id, toolName: block.name, args: block.arguments });
				emit({ type: "message_end", message: assistant.data });
				continue;
			}
			const tool = toolResultSchema.safeParse(model);
			if (tool.success) emit({ type: "tool_execution_end", toolCallId: tool.data.toolCallId, toolName: tool.data.toolName, result: (tool.data.content ?? []).map((block) => block.text).join("\n"), isError: tool.data.isError ?? false });
		}
	}
	const partial = snapshot.generation?.message;
	if (partial) partial.content.forEach((block, contentIndex) => {
		if (block.type !== "text" && block.type !== "thinking") return;
		const value = block.type === "text" ? block.text : block.thinking;
		const previous = partialBlocks?.get(contentIndex) ?? "";
		const delta = value.startsWith(previous) ? value.slice(previous.length) : value;
		if (delta && block.type === "text") emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex, delta } });
		else if (delta) emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex, delta } });
		partialBlocks?.set(contentIndex, value);
	});
	for (const tool of snapshot.tools) {
		if (tool.status === "done") continue;
		emit({ type: "tool_execution_start", toolCallId: tool.callId, toolName: tool.name, args: {} });
		if (tool.output) emit({ type: "tool_execution_update", toolCallId: tool.callId, toolName: tool.name, partialResult: tool.output });
	}
	if (terminalStatus && !snapshot.run && snapshot.inbox.length === 0) {
		emit({ type: "turn_end", message: last });
		emit({ type: "agent_end", messages: last ? [last] : [], status: terminalStatus });
	}
}

type ViewCommand = z.infer<typeof NativeChildViewCommandSchema>;
type ChildView = { command: ViewCommand; stop(): Promise<void> };

export class NativeChildViews {
	private readonly views = new Map<string, ChildView>();
	private readonly pending = new Map<string, Promise<void>>();
	private closed = false;
	private readonly durable: Pick<OpenDurableResult, "harness" | "view">;
	private readonly emit: (event: z.infer<typeof NativeChildViewEventSchema>) => void;
	constructor(durable: Pick<OpenDurableResult, "harness" | "view">, emit: (event: z.infer<typeof NativeChildViewEventSchema>) => void) {
		this.durable = durable;
		this.emit = emit;
	}

	async handle(value: unknown): Promise<void> {
		const command = NativeChildViewCommandSchema.parse(value);
		if (this.closed) throw new Error("Native child view closed");
		const current = this.durable.view.current();
		const proof = await inspectNativeChildIdentity(this.durable.harness, current.session.id, command, BACKGROUND_CONTEXT);
		if (!proof.valid) throw new Error("Native child view denied");
		if (command.type === "native-child-view-detach") {
			await this.pending.get(command.viewId);
			const view = this.views.get(command.viewId);
			if (!view) return;
			this.assertSame(view.command, command);
			this.views.delete(command.viewId);
			await view.stop();
			return;
		}
		const existing = this.views.get(command.viewId);
		if (existing) { this.assertSame(existing.command, command); return; }
		if (this.pending.has(command.viewId)) throw new Error("Native child view already attaching");
		const attaching = this.attach(command);
		this.pending.set(command.viewId, attaching);
		try { await attaching; } finally { this.pending.delete(command.viewId); }
	}

	private async attach(command: ViewCommand): Promise<void> {
		const child = await this.durable.harness.conversation(command.childConversationId, BACKGROUND_CONTEXT);
		if (!child) throw new Error("Native child view denied");
		const state = await child.viewState(BACKGROUND_CONTEXT);
		let stream: AgentEventStream | undefined;
		try {
			stream = await watchEvents(this.durable.harness, child.id, BACKGROUND_CONTEXT);
			if (this.closed) throw new Error("Native child view closed");
			let terminal = false;
			let lastAssistant: BBAssistantMessage | undefined;
			const seenEntries = new Set<number>();
			const partialBlocks = new Map<number, string>();
			const settlement = async (): Promise<"completed" | "failed" | "interrupted" | undefined> => {
				const record = await this.durable.harness.commit((tx) => tx.submissionByRequest(command.childConversationId, `subagent:${command.taskId}`), BACKGROUND_CONTEXT);
				if (record?.status === "done") return "completed";
				if (record?.status === "unanswered") return record.reason === "aborted" ? "interrupted" : "failed";
				return undefined;
			};
			const send = (event: BBWireEvent) => {
				if (terminal) return;
				if (event.type === "message_end") lastAssistant = event.message;
				if (event.type === "agent_end" && event.messages.length === 0 && lastAssistant) event = { ...event, messages: [lastAssistant] };
				this.emit({ type: "native-child-view-event", viewId: command.viewId, durableSessionId: command.durableSessionId, taskId: command.taskId, childConversationId: command.childConversationId, event: { ...event } });
				if (event.type === "agent_end") terminal = true;
			};
			const adapter = new BBEventAdapter(send);
			const finish = (status: "completed" | "failed" | "interrupted"): void => {
				if (terminal) return;
				send({ type: "turn_end", message: lastAssistant });
				send({ type: "agent_end", messages: lastAssistant ? [lastAssistant] : [], status });
			};
			projectNativeChildSnapshot(stream.snapshot, send, await settlement(), seenEntries, partialBlocks);
			const captured = stream;
			const view: ChildView = { command, stop: async () => { try { await captured.stop(); } finally { state.dispose(); } } };
			stream.start(async (events) => {
				for (const event of events) {
					if (event.type === "snapshot") projectNativeChildSnapshot(event, send, await settlement(), seenEntries, partialBlocks);
					else if (event.type === "submission" && event.record.requestId === `subagent:${command.taskId}` && (event.record.status === "done" || event.record.status === "unanswered")) {
						const status = event.record.status === "done" ? "completed" : event.record.reason === "aborted" ? "interrupted" : "failed";
						finish(status);
					} else if (event.type === "run_end") {
						const status = await settlement();
						if (status) finish(status);
					} else {
						if (event.type === "message_end" || event.type === "entry_appended") seenEntries.add(event.entry.id);
						if (event.type === "message_end") partialBlocks.clear();
						if (event.type === "message_update") for (const change of event.changes) {
							if (change.type === "text_delta" || change.type === "thinking_delta") partialBlocks.set(change.contentIndex, (partialBlocks.get(change.contentIndex) ?? "") + change.delta);
						}
						adapter.handleEvent(event, { ...this.durable.view.current(), conversation: state.value });
					}
				}
			});
			this.views.set(command.viewId, view);
			void stream.closed.then(() => {
				if (this.views.get(command.viewId) === view) {
					this.views.delete(command.viewId);
					state.dispose();
				}
			});
		} catch (error) {
			await stream?.stop();
			state.dispose();
			throw error;
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		await Promise.allSettled(this.pending.values());
		const views = [...this.views.values()];
		this.views.clear();
		await Promise.all(views.map((view) => view.stop()));
	}

	private assertSame(previous: ViewCommand, current: ViewCommand): void {
		if (previous.durableSessionId !== current.durableSessionId || previous.parentConversationId !== current.parentConversationId || previous.childConversationId !== current.childConversationId || previous.taskId !== current.taskId) throw new Error("Native child view rebind denied");
	}
}
