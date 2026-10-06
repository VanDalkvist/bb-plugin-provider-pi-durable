import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { LiveState, ToolSlot } from "@earendil-works/pi-durable";
import type { DurableView } from "../runtime.ts";
import type {
	BBAgentEndEvent,
	BBAgentStartEvent,
	BBAssistantMessage,
	BBMessageEndEvent,
	BBMessageUpdateEvent,
	BBThinkingDeltaEvent,
	BBToolExecutionEndEvent,
	BBToolExecutionStartEvent,
	BBToolExecutionUpdateEvent,
	BBTurnEndEvent,
	BBTurnStartEvent,
} from "./contracts.ts";

export type BBWireEvent =
	| BBAgentStartEvent
	| BBTurnStartEvent
	| BBMessageUpdateEvent
	| BBThinkingDeltaEvent
	| BBToolExecutionStartEvent
	| BBToolExecutionUpdateEvent
	| BBToolExecutionEndEvent
	| BBMessageEndEvent
	| BBTurnEndEvent
	| BBAgentEndEvent;

interface ToolTrackingState {
	name: string;
	status: string;
	outputLength: number;
}

/**
 * Resolves tool call arguments from the active generation message or transcript entries.
 * Addresses defect D-1 / A-1 (AP-012, AP-026).
 */
export function resolveToolCallArgs(callId: string, current: DurableView): Record<string, unknown> {
	const live = (current.conversation.docs["pi.live"] ?? {}) as LiveState;

	// 1. Check current live generation message toolCalls
	const activeCalls = ((live.generation?.message?.content ?? []) as any[]).filter(
		(b) => b?.type === "toolCall",
	);
	if (activeCalls.length > 0) {
		const matched = activeCalls.find((c) => c.id === callId || c.callId === callId);
		if (matched?.arguments && typeof matched.arguments === "object") {
			return matched.arguments;
		}
	}

	// 2. Check recent assistant entries from the conversation transcript
	const entries = current.conversation.entries ?? [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as any;
		if (entry?.kind === "pi.assistant" && Array.isArray(entry?.model)) {
			for (const msg of entry.model) {
				if (Array.isArray(msg?.content)) {
					for (const part of msg.content) {
						if (part.type === "toolCall" && (part.id === callId || part.callId === callId)) {
							if (part.arguments && typeof part.arguments === "object") {
								return part.arguments;
							}
						}
					}
				}
			}
		}
	}

	// 3. Fallback to slot input / args
	const slot = (live.tools ?? []).find((s) => (s.callId ?? String((s as any).id)) === callId) as any;
	if (slot?.args && typeof slot.args === "object") {
		return slot.args;
	}
	if (slot?.input && typeof slot.input === "object") {
		return slot.input;
	}

	return {};
}

/**
 * Encapsulates LiveState tracking and converts deltas into valid BB Wire JSONL events.
 */
export class BBEventAdapter {
	private readonly output: (event: BBWireEvent) => void;
	private inTurn = false;
	private lastGenerationText = "";
	private lastThinkingText = "";
	private activeTools = new Map<string, ToolTrackingState>();

	constructor(output: (event: BBWireEvent) => void) {
		this.output = output;
	}

	public sync(current: DurableView): void {
		const live = (current.conversation.docs["pi.live"] ?? {}) as LiveState;

		// Turn liveness predicate (AP-011, AP-023)
		const hasActiveTools = (live.tools ?? []).some(
			(s) => s.status === "running" || s.status === "pending",
		);
		const isBusy = live.run !== undefined || live.generation !== undefined || hasActiveTools;

		// 1. Transition into active turn
		if (isBusy && !this.inTurn) {
			this.inTurn = true;
			this.lastGenerationText = "";
			this.lastThinkingText = "";
			this.activeTools.clear();
			this.output({ type: "agent_start" });
			this.output({ type: "turn_start" });
		}

		// 2. Stream generation deltas
		if (live.generation?.message?.content) {
			let currentText = "";
			let currentThinking = "";

			for (const block of live.generation.message.content) {
				if (block.type === "text") {
					currentText += block.text ?? "";
				} else if (block.type === "thinking") {
					currentThinking += block.thinking ?? "";
				}
			}

			// Stream thinking delta with contentIndex: 0 (defect D-2)
			if (currentThinking.length > this.lastThinkingText.length) {
				const delta = currentThinking.slice(this.lastThinkingText.length);
				this.lastThinkingText = currentThinking;
				this.output({
					type: "message_update",
					assistantMessageEvent: {
						type: "thinking_delta",
						contentIndex: 0,
						delta,
					},
				});
			}

			// Stream text delta
			if (currentText.length > this.lastGenerationText.length) {
				const delta = currentText.slice(this.lastGenerationText.length);
				this.lastGenerationText = currentText;
				this.output({
					type: "message_update",
					assistantMessageEvent: {
						type: "text_delta",
						contentIndex: 0,
						delta,
					},
				});
			}
		}

		// 3. Process tool slots with exact Pi Durable schema (Defect A-1 / D-1)
		for (const slot of live.tools ?? []) {
			const callId = slot.callId ?? String((slot as any).id);
			const toolName = slot.name ?? (slot as any).toolName ?? "unknown";
			const isDone = slot.status === "done" || (slot.status as string) === "terminal";
			const isRunning = slot.status === "running";
			const prev = this.activeTools.get(callId);

			const getResultAndError = () => {
				const entries = current.conversation.entries ?? [];
				const toolResultEntry = entries.find((e: any) => {
					const msg = e.model?.[0] as any;
					return msg?.role === "toolResult" && msg?.toolCallId === callId;
				});
				const toolResultMsg = (toolResultEntry as any)?.model?.[0] as any;
				const isError = toolResultMsg?.isError ?? (slot as any).isError ?? false;
				const result = toolResultMsg?.content ?? slot.output ?? "";
				return { result, isError };
			};

			if (!prev) {
				// Tool slot newly observed
				if (isRunning || isDone || slot.status === "pending") {
					const toolArgs = resolveToolCallArgs(callId, current);
					this.activeTools.set(callId, {
						name: toolName,
						status: slot.status,
						outputLength: slot.output?.length ?? 0,
					});

					this.output({
						type: "tool_execution_start",
						toolCallId: callId,
						toolName,
						args: toolArgs,
					});

					if (slot.output) {
						this.output({
							type: "tool_execution_update",
							toolCallId: callId,
							toolName,
							partialResult: slot.output,
						});
					}

					if (isDone) {
						const { result, isError } = getResultAndError();
						this.output({
							type: "tool_execution_end",
							toolCallId: callId,
							toolName,
							result,
							isError,
						});
					}
				}
			} else {
				// Existing tool slot update
				if (slot.output && slot.output.length > prev.outputLength) {
					const delta = slot.output.slice(prev.outputLength);
					prev.outputLength = slot.output.length;
					this.output({
						type: "tool_execution_update",
						toolCallId: callId,
						toolName,
						partialResult: delta,
					});
				}

				if (isDone && prev.status !== "done" && prev.status !== "terminal") {
					prev.status = slot.status;
					const { result, isError } = getResultAndError();
					this.output({
						type: "tool_execution_end",
						toolCallId: callId,
						toolName,
						result,
						isError,
					});
				}
			}
		}

		// 4. Transition out of turn (AP-026)
		if (!isBusy && this.inTurn) {
			this.inTurn = false;

			const entries = current.conversation.entries ?? [];

			// Finalize any uncompleted tools before ending turn
			for (const [callId, toolState] of this.activeTools.entries()) {
				if (toolState.status !== "done" && toolState.status !== "terminal") {
					toolState.status = "done";
					const toolResultEntry = entries.find((e: any) => {
						const msg = e.model?.[0] as any;
						return msg?.role === "toolResult" && msg?.toolCallId === callId;
					});
					const toolResultMsg = (toolResultEntry as any)?.model?.[0] as any;
					const isError = toolResultMsg?.isError ?? false;
					const result = toolResultMsg?.content ?? "";
					this.output({
						type: "tool_execution_end",
						toolCallId: callId,
						toolName: toolState.name,
						result,
						isError,
					});
				}
			}

			// Extract final assistant message from transcript or build from streamed deltas
			const lastAssistantEntry = [...entries].reverse().find((e: any) => e.kind === "pi.assistant") as any;
			const lastAssistantMsg = lastAssistantEntry?.model?.[0] as AssistantMessage | undefined;

			let finalMsg: BBAssistantMessage;
			if (lastAssistantMsg) {
				finalMsg = {
					role: "assistant",
					content: (lastAssistantMsg.content as any) ?? [{ type: "text", text: this.lastGenerationText }],
					stopReason: (lastAssistantMsg.stopReason as any) ?? "stop",
					usage: lastAssistantMsg.usage as any,
				};
			} else {
				const finalContent: BBAssistantMessage["content"] = [];
				if (this.lastThinkingText) {
					finalContent.push({ type: "thinking", thinking: this.lastThinkingText });
				}
				if (this.lastGenerationText) {
					finalContent.push({ type: "text", text: this.lastGenerationText });
				}

				const usageDoc = (current.conversation.docs["pi.usage"] ?? {}) as any;
				finalMsg = {
					role: "assistant",
					content: finalContent.length > 0 ? finalContent : [{ type: "text", text: "" }],
					stopReason: "stop",
					usage: {
						input: usageDoc.input,
						output: usageDoc.output,
						cacheRead: usageDoc.cacheRead,
						cacheWrite: usageDoc.cacheWrite,
						totalTokens: usageDoc.totalTokens ?? (usageDoc.input ?? 0) + (usageDoc.output ?? 0),
						cost: usageDoc.cost,
					},
				};
			}

			this.output({ type: "message_end", message: finalMsg });
			this.output({ type: "turn_end", message: finalMsg });
			this.output({ type: "agent_end", messages: [finalMsg] });

			this.lastGenerationText = "";
			this.lastThinkingText = "";
			this.activeTools.clear();
		}
	}
}
