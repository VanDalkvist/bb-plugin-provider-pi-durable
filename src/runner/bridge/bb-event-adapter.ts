import type { LiveState, ToolSlot } from "@earendil-works/pi-durable";
import type { DurableView } from "../runtime.ts";
import type { BBWireEvent } from "./contracts.ts";
import { resolveToolCallArgs } from "./tool-args-resolver.ts";
import { buildFinalAssistantMessage } from "./assistant-message-builder.ts";

export { resolveToolCallArgs };

interface ToolTrackingState {
	name: string;
	status: string;
	outputLength: number;
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

		const getResultAndError = (callId: string, slot?: ToolSlot) => {
			const entries = current.conversation.entries ?? [];
			const toolResultEntry = entries.find((e: any) => {
				const msg = e.model?.[0] as any;
				return msg?.role === "toolResult" && msg?.toolCallId === callId;
			});
			const toolResultMsg = (toolResultEntry as any)?.model?.[0] as any;
			const isError = toolResultMsg?.isError ?? (slot as any)?.isError ?? false;
			const result = toolResultMsg?.content ?? slot?.output ?? "";
			return { result, isError };
		};

		// 3. Process tool slots with exact Pi Durable schema (Defect A-1 / D-1)
		for (const slot of live.tools ?? []) {
			const callId = slot.callId ?? String((slot as any).id);
			const toolName = slot.name ?? (slot as any).toolName ?? "unknown";
			const isRunning = slot.status === "running";
			const isDone = slot.status === "done" || (slot.status as string) === "terminal";
			const prev = this.activeTools.get(callId);

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
			}
		}

		// 3b. Real-time tool completion: check active tools across live slots & committed entries (Cycle 51)
		for (const [callId, toolState] of this.activeTools.entries()) {
			if (toolState.status === "done" || toolState.status === "terminal") {
				continue;
			}

			const currentSlot = (live.tools ?? []).find(
				(s) => (s.callId ?? String((s as any).id)) === callId,
			);
			const isSlotDone = currentSlot && (currentSlot.status === "done" || (currentSlot.status as string) === "terminal");
			const isSlotGone = currentSlot === undefined;

			const entries = current.conversation.entries ?? [];
			const hasCommittedResult = entries.some((e: any) => {
				const msg = e.model?.[0] as any;
				return msg?.role === "toolResult" && msg?.toolCallId === callId;
			});

			if (isSlotDone || isSlotGone || hasCommittedResult) {
				toolState.status = "done";
				const { result, isError } = getResultAndError(callId, currentSlot);
				this.output({
					type: "tool_execution_end",
					toolCallId: callId,
					toolName: toolState.name,
					result,
					isError,
				});
			}
		}

		// 4. Transition out of turn (AP-026)
		if (!isBusy && this.inTurn) {
			this.inTurn = false;

			// Finalize any uncompleted tools before ending turn
			for (const [callId, toolState] of this.activeTools.entries()) {
				if (toolState.status !== "done" && toolState.status !== "terminal") {
					toolState.status = "done";
					const { result, isError } = getResultAndError(callId);
					this.output({
						type: "tool_execution_end",
						toolCallId: callId,
						toolName: toolState.name,
						result,
						isError,
					});
				}
			}
			this.activeTools.clear();

			const finalMsg = buildFinalAssistantMessage(
				current,
				this.lastGenerationText,
				this.lastThinkingText,
			);

			this.output({ type: "message_end", message: finalMsg });
			this.output({ type: "turn_end", message: finalMsg });
			this.output({ type: "agent_end", messages: [finalMsg] });

			this.lastGenerationText = "";
			this.lastThinkingText = "";
			this.activeTools.clear();
		}
	}
}
