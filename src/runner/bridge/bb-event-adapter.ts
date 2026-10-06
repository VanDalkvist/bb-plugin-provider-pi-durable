import type { AgentEvent } from "@earendil-works/pi-durable";
import type { DurableView } from "../runtime.ts";
import type { BBWireEvent, BBAssistantMessage } from "./contracts.ts";
import { buildFinalAssistantMessage } from "./assistant-message-builder.ts";

export { resolveToolCallArgs } from "./tool-args-resolver.ts";

/**
 * Transforms native @earendil-works/pi-durable AgentEvents into BB Wire JSONL events.
 * Relies directly on the first-party transactional watchEvents stream.
 */
export class BBEventAdapter {
	private readonly output: (event: BBWireEvent) => void;
	private lastAssistantMessage?: BBAssistantMessage;
	private currentText = "";
	private currentThinking = "";

	constructor(output: (event: BBWireEvent) => void) {
		this.output = output;
	}

	public handleEvent(event: AgentEvent, current: DurableView): void {
		switch (event.type) {
			case "run_start": {
				this.currentText = "";
				this.currentThinking = "";
				this.lastAssistantMessage = undefined;
				this.output({ type: "agent_start" });
				break;
			}

			case "turn_start": {
				this.output({ type: "turn_start" });
				break;
			}

			case "message_update": {
				for (const change of event.changes) {
					if (change.type === "thinking_delta") {
						this.currentThinking += change.delta;
						this.output({
							type: "message_update",
							assistantMessageEvent: {
								type: "thinking_delta",
								contentIndex: 0,
								delta: change.delta,
							},
						});
					} else if (change.type === "text_delta") {
						this.currentText += change.delta;
						this.output({
							type: "message_update",
							assistantMessageEvent: {
								type: "text_delta",
								contentIndex: 0,
								delta: change.delta,
							},
						});
					}
				}
				break;
			}

			case "tool_execution_start": {
				this.output({
					type: "tool_execution_start",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args ?? {},
				});
				break;
			}

			case "tool_execution_update": {
				let partialResult = "";
				if (event.output) {
					if ("set" in event.output) {
						partialResult = event.output.set;
					} else if ("append" in event.output) {
						partialResult = event.output.append ?? "";
					}
				}
				if (partialResult) {
					this.output({
						type: "tool_execution_update",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						partialResult,
					});
				}
				break;
			}

			case "tool_execution_end": {
				const toolResultMsg = event.entry?.model?.[0] as any;
				const isError = toolResultMsg?.isError ?? false;
				let result = "";

				if (Array.isArray(toolResultMsg?.content)) {
					result = toolResultMsg.content
						.map((block: any) => (block && typeof block === "object" && "text" in block ? block.text : ""))
						.filter(Boolean)
						.join("\n");
				} else if (typeof toolResultMsg?.content === "string") {
					result = toolResultMsg.content;
				}

				this.output({
					type: "tool_execution_end",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					result,
					isError,
				});
				break;
			}

			case "message_end": {
				const msg = event.entry?.model?.[0] as any;
				if (msg?.role === "assistant") {
					this.lastAssistantMessage = {
						role: "assistant",
						content: msg.content ?? [{ type: "text", text: this.currentText }],
						stopReason: msg.stopReason ?? "stop",
						usage: msg.usage,
					};
					this.output({
						type: "message_end",
						message: this.lastAssistantMessage,
					});
				}
				break;
			}

			case "turn_end": {
				const finalMsg = this.lastAssistantMessage ?? buildFinalAssistantMessage(
					current,
					this.currentText,
					this.currentThinking,
				);
				this.output({
					type: "turn_end",
					message: finalMsg,
				});
				break;
			}

			case "run_end": {
				const finalMsg = this.lastAssistantMessage ?? buildFinalAssistantMessage(
					current,
					this.currentText,
					this.currentThinking,
				);
				this.output({
					type: "agent_end",
					messages: [finalMsg],
				});
				break;
			}
		}
	}
}
