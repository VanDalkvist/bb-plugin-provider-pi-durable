import {
	translateToolStart,
	translateToolUpdate,
	translateToolEnd,
} from "./tool-delta-translator.ts";
import type { RunnerEvent, ThreadDelta } from "./types.ts";

export interface DeltaTranslatorContext {
	threadId: string;
	cwd?: string;
	clientRequestId?: string;
}

export class DeltaTranslator {
	private activeTools = new Map<string, Record<string, unknown>>();
	private currentThinkingIndex = 0;
	private currentAgentText = "";
	private turnOpenSent = false;
	private turnBoundarySent = false;

	public reset(): void {
		this.activeTools.clear();
		this.currentThinkingIndex = 0;
		this.currentAgentText = "";
		this.turnOpenSent = false;
		this.turnBoundarySent = false;
	}

	public translate(event: RunnerEvent, ctx: DeltaTranslatorContext): ThreadDelta[] {
		const deltas: ThreadDelta[] = [];
		const fallbackCwd = ctx.cwd || process.cwd();

		switch (event.type) {
			case "agent_start":
			case "turn_start": {
				if (!this.turnOpenSent) {
					this.turnOpenSent = true;
					deltas.push({ kind: "turn.open" });
				}
				break;
			}

			case "compaction_start": {
				const isManual = event.reason === "manual";
				if (isManual && !this.turnOpenSent) {
					this.turnOpenSent = true;
					deltas.push({ kind: "turn.open" });
				}
				deltas.push({
					kind: "item.open",
					key: { channel: "compaction" },
					item: { type: "compaction" },
					...(isManual ? {} : { attach: "currentOrLast" }),
				});
				break;
			}

			case "compaction_end": {
				deltas.push({ kind: "context.compacted" });
				deltas.push({ kind: "turn.boundary", status: "completed" });
				this.turnOpenSent = false;
				break;
			}

			case "context_window": {
				deltas.push({
					kind: "contextWindow",
					used: typeof event.usedTokens === "number" ? event.usedTokens : null,
					size: typeof event.contextWindow === "number" ? event.contextWindow : null,
					estimated: true,
					attach: "currentOrLast",
				});
				break;
			}

			case "message_update": {
				const asst = event.assistantMessageEvent as Record<string, unknown> | undefined;
				if (!asst) break;

				if (asst.type === "thinking_delta" && typeof asst.delta === "string") {
					const idx = typeof asst.contentIndex === "number" ? asst.contentIndex : this.currentThinkingIndex;
					deltas.push({
						kind: "item.textDelta",
						key: { channel: `thinking-${idx}` },
						channel: "reasoningText",
						text: asst.delta,
					});
				} else if (asst.type === "thinking_end") {
					const idx = typeof asst.contentIndex === "number" ? asst.contentIndex : this.currentThinkingIndex;
					deltas.push({
						kind: "item.textClose",
						key: { channel: `thinking-${idx}` },
						channel: "reasoningText",
						text: (asst.content as string) ?? "",
					});
					this.currentThinkingIndex++;
				} else if (asst.type === "text_delta" && typeof asst.delta === "string") {
					this.currentAgentText += asst.delta;
					deltas.push({
						kind: "item.textDelta",
						key: { channel: "agentMessage" },
						channel: "agentMessage",
						text: asst.delta,
					});
				}
				break;
			}

			case "message_end": {
				const msg = event.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
				let finalText = this.currentAgentText;
				if (msg?.content && Array.isArray(msg.content)) {
					const textParts = msg.content
						.filter((p) => p && p.type === "text" && typeof p.text === "string")
						.map((p) => p.text as string);
					if (textParts.length > 0) {
						finalText = textParts.join("");
					}
				}

				if (finalText) {
					deltas.push({
						kind: "item.textClose",
						key: { channel: "agentMessage" },
						channel: "agentMessage",
						text: finalText,
					});
				}
				this.currentAgentText = "";
				break;
			}

			case "tool_execution_start": {
				const { shape, delta } = translateToolStart(event, fallbackCwd);
				this.activeTools.set(String(event.toolCallId), shape);
				deltas.push(delta);
				break;
			}

			case "tool_execution_update": {
				const delta = translateToolUpdate(event);
				if (delta) deltas.push(delta);
				break;
			}

			case "tool_execution_end": {
				const callId = String(event.toolCallId);
				const cachedShape = this.activeTools.get(callId);
				this.activeTools.delete(callId);
				deltas.push(translateToolEnd(event, cachedShape, fallbackCwd));
				break;
			}

			case "turn_end": {
				break;
			}

			case "agent_end": {
				if (this.currentAgentText) {
					deltas.push({
						kind: "item.textClose",
						key: { channel: "agentMessage" },
						channel: "agentMessage",
						text: this.currentAgentText,
					});
					this.currentAgentText = "";
				}

				const rawMsg = event.message ?? (event.messages as unknown[])?.[0];
				const usage = (rawMsg as { usage?: Record<string, unknown> } | undefined)?.usage;
				if (usage) {
					const inTok = Number(usage.input ?? 0);
					const outTok = Number(usage.output ?? 0);
					const totTok = Number(usage.totalTokens ?? (inTok + outTok));
					const cwSize = typeof event.contextWindow === "number" && event.contextWindow > 0 ? event.contextWindow : 128000;
					deltas.push({
						kind: "usage",
						modelContextWindow: cwSize,
						last: {
							totalTokens: totTok,
							inputTokens: inTok,
							cachedInputTokens: Number(usage.cacheRead ?? 0),
							cacheReadInputTokens: Number(usage.cacheRead ?? 0),
							cacheWriteInputTokens: Number(usage.cacheWrite ?? 0),
							outputTokens: outTok,
							reasoningOutputTokens: Number(usage.reasoning ?? 0),
						},
						total: {
							totalTokens: totTok,
							inputTokens: inTok,
							cachedInputTokens: Number(usage.cacheRead ?? 0),
							cacheReadInputTokens: Number(usage.cacheRead ?? 0),
							cacheWriteInputTokens: Number(usage.cacheWrite ?? 0),
							outputTokens: outTok,
							reasoningOutputTokens: Number(usage.reasoning ?? 0),
						},
					});

					deltas.push({
						kind: "contextWindow",
						used: totTok,
						size: cwSize,
						estimated: false,
						attach: "currentOrLast",
					});
				}

				if (!this.turnBoundarySent) {
					this.turnBoundarySent = true;
					deltas.push({
						kind: "turn.boundary",
						status: "completed",
						claimIfIdle: true,
					});
				}

				// Reset turn state for subsequent turns
				this.turnOpenSent = false;
				this.turnBoundarySent = false;
				break;
			}
		}

		return deltas;
	}
}
