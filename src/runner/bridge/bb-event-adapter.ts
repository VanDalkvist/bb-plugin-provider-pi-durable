import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { LiveState } from "@earendil-works/pi-durable";
import type { DurableView } from "../runtime.ts";
import type {
	BBAgentEndEvent,
	BBAgentStartEvent,
	BBAssistantMessage,
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
	| BBTurnEndEvent
	| BBAgentEndEvent;

/**
 * Resolves tool call arguments from the active generation message or transcript entries.
 * Addresses defect D-1 (AP-012, AP-026).
 */
export function resolveToolCallArgs(callId: string, current: DurableView): Record<string, unknown> {
	const live = (current.conversation.docs["pi.live"] ?? {}) as LiveState;

	// 1. Check current live generation message toolCalls
	const activeCalls = live.generation?.message?.content?.filter(
		(b): b is { type: "toolCall"; id?: string; callId?: string; name: string; arguments?: Record<string, unknown> } =>
			b.type === "toolCall",
	);
	if (activeCalls) {
		const matched = activeCalls.find((c) => c.id === callId || c.callId === callId);
		if (matched?.arguments && typeof matched.arguments === "object") {
			return matched.arguments;
		}
	}

	// 2. Check the most recent assistant message from the conversation transcript
	const entries = Object.values(current.conversation.entries ?? {});
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

	// 3. Fallback to slot args if present
	const slot = (live.tools ?? []).find((s: any) => (s.callId ?? String(s.id)) === callId) as any;
	if (slot?.args && typeof slot.args === "object") {
		return slot.args;
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
	private seenTools = new Map<string, { status: string; resultLen: number }>();

	constructor(output: (event: BBWireEvent) => void) {
		this.output = output;
	}

	public sync(current: DurableView): void {
		const live = (current.conversation.docs["pi.live"] ?? {}) as LiveState;

		// Calculate isBusy considering active tools (defect D-3)
		const hasActiveTools = (live.tools ?? []).some(
			(s: any) => s.status === "running" || s.status === "pending",
		);
		const isBusy = live.run?.status === "running" || live.generation !== undefined || hasActiveTools;

		// 1. Transition into active turn
		if (isBusy && !this.inTurn) {
			this.inTurn = true;
			this.lastGenerationText = "";
			this.lastThinkingText = "";
			this.seenTools.clear();
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

		// 3. Process tool slots
		for (const slot of (live.tools ?? []) as any[]) {
			const callId = slot.callId ?? String(slot.id);
			const prev = this.seenTools.get(callId);

			if (!prev) {
				// Tool execution started: resolve real arguments (defect D-1)
				const toolArgs = resolveToolCallArgs(callId, current);
				const toolName = slot.toolName ?? "unknown";

				this.output({
					type: "tool_execution_start",
					toolCallId: callId,
					toolName,
					args: toolArgs,
				});

				const resultStr = typeof slot.result === "string" ? slot.result : "";
				this.seenTools.set(callId, { status: slot.status, resultLen: resultStr.length });
			} else if (slot.status === "running" && typeof slot.result === "string" && slot.result.length > prev.resultLen) {
				const partial = slot.result.slice(prev.resultLen);
				this.seenTools.set(callId, { status: slot.status, resultLen: slot.result.length });
				this.output({
					type: "tool_execution_update",
					toolCallId: callId,
					toolName: slot.toolName ?? "unknown",
					partialResult: partial,
				});
			}

			// Tool completed
			if ((slot.status === "completed" || slot.status === "failed") && prev?.status !== slot.status) {
				const isError = slot.status === "failed" || slot.isError === true;
				this.seenTools.set(callId, {
					status: slot.status,
					resultLen: typeof slot.result === "string" ? slot.result.length : 0,
				});
				this.output({
					type: "tool_execution_end",
					toolCallId: callId,
					toolName: slot.toolName ?? "unknown",
					result: slot.result ?? null,
					isError,
				});
			}
		}

		// 4. Transition out of turn
		if (!isBusy && this.inTurn) {
			this.inTurn = false;
			this.output({ type: "turn_end" });

			// Populate final assistant message with full text and usage (defect D-4)
			const finalContent: BBAssistantMessage["content"] = [];
			if (this.lastThinkingText) {
				finalContent.push({ type: "thinking", thinking: this.lastThinkingText });
			}
			if (this.lastGenerationText) {
				finalContent.push({ type: "text", text: this.lastGenerationText });
			}

			const usageDoc = (current.conversation.docs["pi.usage"] ?? {}) as any;
			const finalMsg: BBAssistantMessage = {
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

			this.output({
				type: "agent_end",
				messages: [finalMsg],
			});
		}
	}
}
