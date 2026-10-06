export interface DeltaTranslatorContext {
	threadId: string;
	cwd?: string;
	clientRequestId?: string;
}

export class DeltaTranslator {
	private activeTools = new Map<string, any>();
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

	public translate(event: any, ctx: DeltaTranslatorContext): any[] {
		const deltas: any[] = [];
		const fallbackCwd = ctx.cwd || process.cwd();

		switch (event.type) {
			case "agent_start":
			case "turn_start": {
				if (!this.turnOpenSent) {
					this.turnOpenSent = true;
					deltas.push({
						kind: "turn.open",
					});
				}
				break;
			}

			case "message_update": {
				const asst = event.assistantMessageEvent;
				if (!asst) break;

				if (asst.type === "thinking_delta" && asst.delta) {
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
						text: asst.content ?? "",
					});
					this.currentThinkingIndex++;
				} else if (asst.type === "text_delta" && asst.delta) {
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
				const msg = event.message;
				let finalText = this.currentAgentText;
				if (msg?.content && Array.isArray(msg.content)) {
					const textParts = msg.content
						.filter((p: any) => p && p.type === "text" && typeof p.text === "string")
						.map((p: any) => p.text);
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
				const callId = String(event.toolCallId);
				const toolName = String(event.toolName);
				const args = event.args ?? {};

				let shape: any;
				if (toolName === "bash") {
					shape = {
						type: "command",
						command: typeof args.command === "string" ? args.command : "",
						cwd: typeof args.cwd === "string" ? args.cwd : fallbackCwd,
					};
				} else if (toolName === "edit" || toolName === "write") {
					const filePath = typeof args.path === "string" ? args.path : "";
					shape = {
						type: "fileChange",
						changes: filePath ? [{ path: filePath, kind: toolName === "write" ? "create" : "modify" }] : [],
					};
				} else {
					shape = {
						type: "tool",
						tool: toolName,
						server: "pi",
						args,
					};
				}

				this.activeTools.set(callId, shape);
				deltas.push({
					kind: "item.open",
					key: { providerItemId: callId },
					item: shape,
				});
				break;
			}

			case "tool_execution_update": {
				const callId = String(event.toolCallId);
				const toolName = String(event.toolName);
				if (event.partialResult) {
					if (toolName === "bash") {
						deltas.push({
							kind: "command.outputSnapshot",
							key: { providerItemId: callId },
							text: String(event.partialResult),
						});
					} else {
						deltas.push({
							kind: "item.progress",
							key: { providerItemId: callId },
							message: String(event.partialResult),
						});
					}
				}
				break;
			}

			case "tool_execution_end": {
				const callId = String(event.toolCallId);
				const toolName = String(event.toolName);
				const shape = this.activeTools.get(callId) ?? {
					type: toolName === "bash" ? "command" : "tool",
					...(toolName === "bash"
						? { command: "", cwd: fallbackCwd }
						: { tool: toolName, server: "pi" }),
				};
				this.activeTools.delete(callId);

				const resultText = typeof event.result === "string"
					? event.result
					: JSON.stringify(event.result ?? "");

				deltas.push({
					kind: "item.close",
					key: { providerItemId: callId },
					status: event.isError ? "failed" : "completed",
					exitCode: event.isError ? 1 : 0,
					resultText,
					aggregatedOutput: shape.type === "command" ? resultText : undefined,
					item: shape,
				});
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

				const usage = event.message?.usage ?? event.messages?.[0]?.usage;
				if (usage) {
					const inTok = Number(usage.input ?? 0);
					const outTok = Number(usage.output ?? 0);
					const totTok = Number(usage.totalTokens ?? (inTok + outTok));
					deltas.push({
						kind: "usage",
						modelContextWindow: 200000,
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
