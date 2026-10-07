import type { AgentEvent } from "@earendil-works/pi-durable";
import type { DurableView } from "../runtime.ts";
import {
	isAgentDocument,
	type BBWireEvent,
	type BBAssistantMessage,
	type BBAssistantMessageUsage,
} from "./contracts.ts";
import { buildFinalAssistantMessage } from "./assistant-message-builder.ts";

export { resolveToolCallArgs } from "./tool-args-resolver.ts";

interface RawToolResultMessage {
	isError?: boolean;
	content?: string | Array<{ text?: string; [key: string]: unknown }>;
	[key: string]: unknown;
}

interface RawAssistantEntryMessage {
	role?: string;
	content?: BBAssistantMessage["content"];
	stopReason?: BBAssistantMessage["stopReason"];
	usage?: BBAssistantMessageUsage;
	[key: string]: unknown;
}

function extractToolResult(modelItem: unknown): { result: string; isError: boolean } {
	const msg = typeof modelItem === "object" && modelItem !== null ? (modelItem as RawToolResultMessage) : undefined;
	const isError = msg?.isError ?? false;
	let result = "";
	if (Array.isArray(msg?.content)) {
		result = msg.content
			.map((b) => (typeof b === "object" && b !== null && typeof b.text === "string" ? b.text : ""))
			.filter(Boolean)
			.join("\n");
	} else if (typeof msg?.content === "string") {
		result = msg.content;
	}
	return { result, isError };
}

/**
 * Transforms native @earendil-works/pi-durable AgentEvents into BB Wire JSONL events.
 * Relies directly on the first-party transactional watchEvents stream.
 */
export class BBEventAdapter {
	private readonly output: (event: BBWireEvent) => void;
	private readonly resolveContextWindow?: (provider?: string, modelId?: string) => number | undefined;
	private lastAssistantMessage?: BBAssistantMessage;
	private currentText = "";
	private currentThinking = "";
	private isInThinking = false;

	constructor(
		output: (event: BBWireEvent) => void,
		resolveContextWindow?: (provider?: string, modelId?: string) => number | undefined,
	) {
		this.output = output;
		this.resolveContextWindow = resolveContextWindow;
	}

	private closeThinkingIfNeeded(): void {
		if (!this.isInThinking) return;
		this.isInThinking = false;
		this.output({
			type: "message_update",
			assistantMessageEvent: {
				type: "thinking_end",
				contentIndex: 0,
				content: this.currentThinking,
			},
		});
	}

	public handleEvent(event: AgentEvent, current: DurableView): void {
		switch (event.type) {
			case "run_start": {
				this.currentText = "";
				this.currentThinking = "";
				this.isInThinking = false;
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
						this.isInThinking = true;
						this.currentThinking += change.delta;
						this.output({
							type: "message_update",
							assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: change.delta },
						});
					} else if (change.type === "text_delta") {
						this.closeThinkingIfNeeded();
						this.currentText += change.delta;
						this.output({
							type: "message_update",
							assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: change.delta },
						});
					}
				}
				break;
			}

			case "tool_execution_start": {
				this.closeThinkingIfNeeded();
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
					if ("set" in event.output) partialResult = event.output.set;
					else if ("append" in event.output) partialResult = event.output.append ?? "";
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
				const { result, isError } = extractToolResult(event.entry?.model?.[0]);
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
				this.closeThinkingIfNeeded();
				const modelItem = event.entry?.model?.[0];
				const msg: RawAssistantEntryMessage | undefined =
					typeof modelItem === "object" && modelItem !== null ? (modelItem as RawAssistantEntryMessage) : undefined;
				if (msg?.role === "assistant") {
					this.lastAssistantMessage = {
						role: "assistant",
						content: msg.content ?? [{ type: "text", text: this.currentText }],
						stopReason: msg.stopReason ?? "stop",
						usage: msg.usage,
					};
					this.output({ type: "message_end", message: this.lastAssistantMessage });
				}
				break;
			}

			case "compaction_start": {
				this.output({
					type: "compaction_start",
					reason: event.reason === "threshold" ? "threshold" : "manual",
				});
				break;
			}

			case "compaction_end": {
				this.output({
					type: "compaction_end",
					reason: event.reason === "threshold" ? "threshold" : "manual",
					aborted: false,
				});
				break;
			}

			case "turn_end": {
				this.closeThinkingIfNeeded();
				const finalMsg = this.lastAssistantMessage ?? buildFinalAssistantMessage(
					current,
					this.currentText,
					this.currentThinking,
				);
				const rawAgentDoc = current?.conversation?.docs?.["pi.agent"];
				const agentDoc = isAgentDocument(rawAgentDoc) ? rawAgentDoc : {};
				const cw = this.resolveContextWindow?.(agentDoc.model?.provider, agentDoc.model?.modelId);
				this.output({ type: "turn_end", message: finalMsg, contextWindow: cw });
				break;
			}

			case "run_end": {
				this.closeThinkingIfNeeded();
				const finalMsg = this.lastAssistantMessage ?? buildFinalAssistantMessage(
					current,
					this.currentText,
					this.currentThinking,
				);
				const rawAgentDoc = current?.conversation?.docs?.["pi.agent"];
				const agentDoc = isAgentDocument(rawAgentDoc) ? rawAgentDoc : {};
				const cw = this.resolveContextWindow?.(agentDoc.model?.provider, agentDoc.model?.modelId);
				this.output({ type: "agent_end", messages: [finalMsg], contextWindow: cw });
				break;
			}
		}
	}
}
