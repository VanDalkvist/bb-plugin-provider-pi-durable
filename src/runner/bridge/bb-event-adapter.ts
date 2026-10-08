import type { AgentEvent, SnapshotEvent } from "@earendil-works/pi-durable";
import type { DurableView } from "../runtime.ts";
import {
	isAgentDocument,
	isConversationEntryRecord,
	type AgentDocument,
	type ConversationEntryRecord,
	type BBWireEvent,
	type BBAssistantMessage,
	type BBAssistantMessageUsage,
	type CumulativeUsageMetrics,
} from "./contracts.ts";
import {
	buildFinalAssistantMessage,
	extractCumulativeUsage,
} from "./assistant-message-builder.ts";
import {
	buildToolExecutionUpdate,
	buildToolExecutionEnd,
} from "./tool-result-extractor.ts";

export { resolveToolCallArgs } from "./tool-args-resolver.ts";

interface RawAssistantEntryMessage {
	role?: string;
	content?: BBAssistantMessage["content"];
	stopReason?: BBAssistantMessage["stopReason"];
	usage?: BBAssistantMessageUsage;
	[key: string]: unknown;
}

/**
 * Transforms native @earendil-works/pi-durable AgentEvents into BB Wire JSONL events.
 * Relies directly on the first-party transactional watchEvents stream.
 */
export class BBEventAdapter {
	private readonly output: (event: BBWireEvent) => void;
	private readonly resolveContextWindow?: (provider?: string, modelId?: string) => number | undefined;
	private lastAssistantMessage?: BBAssistantMessage;
	private lastCheckpointId?: string;
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
			assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: this.currentThinking },
		});
	}

	private resolveTurnSummary(current: DurableView): {
		finalMsg: BBAssistantMessage;
		cw?: number;
		cumulativeUsage?: CumulativeUsageMetrics;
		isAborted: boolean;
	} {
		this.closeThinkingIfNeeded();
		const tail = current?.conversation?.entries?.at(-1);
		if (tail?.id !== undefined) {
			this.lastCheckpointId = String(tail.id);
		}
		const finalMsg = this.lastAssistantMessage ?? buildFinalAssistantMessage(
			current,
			this.currentText,
			this.currentThinking,
		);
		const rawAgentDoc = current?.conversation?.docs?.["pi.agent"];
		const agentDoc: AgentDocument = isAgentDocument(rawAgentDoc) ? rawAgentDoc : {};
		const cw = this.resolveContextWindow?.(agentDoc.model?.provider, agentDoc.model?.modelId);
		const cumulativeUsage = extractCumulativeUsage(current);

		const entries = current?.conversation?.entries ?? [];
		const lastAssistantEntry = [...entries].reverse().find(
			(e): e is ConversationEntryRecord => isConversationEntryRecord(e) && e.kind === "pi.assistant",
		);
		const firstModelMsg = lastAssistantEntry?.model?.[0];
		const isLastAssistantAborted = Boolean(
			firstModelMsg && "stopReason" in firstModelMsg && (firstModelMsg as { stopReason?: string }).stopReason === "aborted",
		);
		const isAborted = finalMsg.stopReason === "aborted" || isLastAssistantAborted;

		if (isAborted && finalMsg.stopReason !== "aborted") {
			finalMsg.stopReason = "aborted";
		}

		return { finalMsg, cw, cumulativeUsage, isAborted };
	}

	public handleEvent(event: AgentEvent, current: DurableView): void {
		switch (event.type) {
			case "snapshot": {
				const snapWithView = event as SnapshotEvent & {
					view?: { conversation?: { entries?: readonly { id?: string | number }[] } };
				};
				const entries =
					snapWithView.view?.conversation?.entries ??
					event.entries ??
					current?.conversation?.entries;
				const tail = entries?.at(-1);
				if (tail?.id !== undefined) {
					this.lastCheckpointId = String(tail.id);
				}
				break;
			}

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
				const update = buildToolExecutionUpdate(event);
				if (update) this.output(update);
				break;
			}

			case "tool_execution_end": {
				this.output(buildToolExecutionEnd(event));
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
				this.output({ type: "compaction_start", reason: event.reason === "threshold" ? "threshold" : "manual" });
				break;
			}
			case "compaction_end": {
				this.output({ type: "compaction_end", reason: event.reason === "threshold" ? "threshold" : "manual", aborted: false });
				break;
			}

			case "turn_end": {
				const { finalMsg, cw, cumulativeUsage, isAborted } = this.resolveTurnSummary(current);
				this.output({
					type: "turn_end",
					message: finalMsg,
					contextWindow: cw,
					...(this.lastCheckpointId ? { providerCheckpointId: this.lastCheckpointId } : {}),
					...(cumulativeUsage ? { cumulativeUsage } : {}),
					...(isAborted ? { aborted: true, stopReason: "aborted" } : {}),
				});
				break;
			}

			case "run_end": {
				const { finalMsg, cw, cumulativeUsage, isAborted } = this.resolveTurnSummary(current);
				this.output({
					type: "agent_end",
					messages: [finalMsg],
					contextWindow: cw,
					...(this.lastCheckpointId ? { providerCheckpointId: this.lastCheckpointId } : {}),
					...(cumulativeUsage ? { cumulativeUsage } : {}),
					...(isAborted ? { aborted: true, stopReason: "aborted" } : {}),
				});
				break;
			}

			case "auto_retry_start": {
				this.output({
					type: "auto_retry_start",
					attempt: event.attempt,
					...(event.at !== undefined ? { at: event.at } : {}),
					...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
				});
				break;
			}
			case "auto_retry_end": {
				this.output({ type: "auto_retry_end", attempt: event.attempt });
				break;
			}
		}
	}
}
