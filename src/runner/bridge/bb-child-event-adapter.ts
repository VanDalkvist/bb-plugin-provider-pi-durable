import type { AgentEvent } from "@earendil-works/pi-durable";
import type { DurableView } from "../runtime.ts";
import type { BBWireEvent } from "./contracts.ts";
import { ToolEventProjector } from "./tool-result-extractor.ts";
import { resolveChildRunOutcome } from "./child-run-outcome.ts";

export class BBChildEventAdapter {
	private readonly output: (event: BBWireEvent) => void;
	private readonly parentRef: string;
	private readonly conversationId?: string | number;
	private readonly toolProjector = new ToolEventProjector();
	private readonly submissions = new Map<string | number, { status: string; reason?: string; detail?: string }>();
	private lastTaskError?: string;
	private currentText = "";
	private currentThinking = "";
	private isInThinking = false;

	constructor(output: (event: BBWireEvent) => void, parentRef: string, conversationId?: string | number) {
		this.output = output;
		this.parentRef = parentRef;
		this.conversationId = conversationId;
	}

	private closeThinkingIfNeeded(): void {
		if (!this.isInThinking) return;
		this.isInThinking = false;
		this.output({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: this.currentThinking },
			parentRef: this.parentRef,
			...(this.conversationId !== undefined ? { conversationId: this.conversationId } : {}),
		});
	}

	public handleBatch(batch: readonly AgentEvent[], current?: DurableView): void {
		if (batch.some((ev) => ev.type === "run_start")) {
			this.lastTaskError = undefined;
			this.submissions.clear();
		}
		for (const ev of batch) {
			if (ev.type === "task_failed") {
				this.lastTaskError = (ev as any).message;
			} else if (ev.type === "submission" && (ev as any).record?.id !== undefined) {
				this.submissions.set((ev as any).record.id, (ev as any).record);
			}
		}
		for (const ev of batch) {
			this.handleEvent(ev, current);
		}
	}

	public handleEvent(event: AgentEvent, _current?: DurableView): void {
		switch (event.type) {
			case "message_update": {
				for (const change of event.changes) {
					const thinkDelta = change.type === "thinking_delta" ? change.delta : (change.type === "thinking_start" && change.block.type === "thinking" && change.block.thinking) ? change.block.thinking : undefined;
					const textDelta = change.type === "text_delta" ? change.delta : (change.type === "text_start" && change.block.type === "text" && change.block.text) ? change.block.text : undefined;
					if (thinkDelta) {
						this.isInThinking = true;
						this.currentThinking += thinkDelta;
						this.output({
							type: "message_update",
							assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: thinkDelta },
							parentRef: this.parentRef,
							...(this.conversationId !== undefined ? { conversationId: this.conversationId } : {}),
						});
					} else if (textDelta) {
						this.closeThinkingIfNeeded();
						this.currentText += textDelta;
						this.output({
							type: "message_update",
							assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: textDelta },
							parentRef: this.parentRef,
							...(this.conversationId !== undefined ? { conversationId: this.conversationId } : {}),
						});
					}
				}
				break;
			}
			case "tool_execution_start": {
				this.closeThinkingIfNeeded();
				this.output({
					type: "tool_execution_start",
					toolCallId: `${this.parentRef}:${event.toolCallId}`,
					toolName: event.toolName,
					args: event.args ?? {},
					parentRef: this.parentRef,
					...(this.conversationId !== undefined ? { conversationId: this.conversationId } : {}),
				});
				break;
			}
			case "tool_execution_update": {
				const update = this.toolProjector.projectToolUpdate(
					{ ...event, toolCallId: `${this.parentRef}:${event.toolCallId}` },
					this.parentRef,
				);
				if (update) {
					this.output({
						...update,
						...(this.conversationId !== undefined ? { conversationId: this.conversationId } : {}),
					});
				}
				break;
			}
			case "tool_execution_end": {
				const end = this.toolProjector.projectToolEnd(
					{ ...event, toolCallId: `${this.parentRef}:${event.toolCallId}` },
					this.parentRef,
				);
				this.output({
					...end,
					...(this.conversationId !== undefined ? { conversationId: this.conversationId } : {}),
				});
				break;
			}
			case "message_end": {
				this.closeThinkingIfNeeded();
				const message = event.entry?.model?.[0];
				if (message?.role === "assistant" && Array.isArray(message.content)) {
					const fullText = message.content
						.flatMap((part) => (part.type === "text" ? [part.text] : []))
						.join("");
					if (fullText.startsWith(this.currentText) && fullText.length > this.currentText.length) {
						const delta = fullText.slice(this.currentText.length);
						this.output({
							type: "message_update",
							assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
							parentRef: this.parentRef,
							...(this.conversationId !== undefined ? { conversationId: this.conversationId } : {}),
						});
					}
					this.currentText = "";
					this.currentThinking = "";
				}
				break;
			}
			case "run_end": {
				this.closeThinkingIfNeeded();
				this.toolProjector.clear();
				const outcome = resolveChildRunOutcome(event.inputs, this.submissions, this.lastTaskError);
				this.output({
					type: "agent_end",
					messages: [],
					parentRef: this.parentRef,
					...(this.conversationId !== undefined ? { conversationId: this.conversationId } : {}),
					...(outcome.isAborted ? { aborted: true, stopReason: "aborted" } : {}),
					...(outcome.isError && !outcome.isAborted ? { stopReason: "error", ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}) } : {}),
				});
				break;
			}
			case "turn_start": {
				this.output({
					type: "turn_start",
					parentRef: this.parentRef,
					...(this.conversationId !== undefined ? { conversationId: this.conversationId } : {}),
				});
				break;
			}
			case "snapshot": {
				const snap = event as Extract<AgentEvent, { type: "snapshot" }>;
				const prefix = (slots?: readonly { callId: string | number; output?: unknown; details?: unknown }[]) =>
					slots?.map((s) => ({ ...s, callId: `${this.parentRef}:${s.callId}` }));
				this.toolProjector.seedFromSnapshot(prefix(snap.tools), prefix(snap.nestedTools));
				break;
			}
			case "run_start": {
				this.toolProjector.clear();
				break;
			}
			default:
				break;
		}
	}
}
