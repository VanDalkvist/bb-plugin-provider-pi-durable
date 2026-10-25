import type { CumulativeUsageMetrics, RunnerEvent, ThreadDelta } from "./types.ts";

import { translateReasoningUpdate } from "./reasoning-delta-translator.ts";
import type { MessageTranslationState } from "./message-state.ts";
export { REASONING_PRESENTATION } from "./reasoning-delta-translator.ts";
export type { MessageTranslationState } from "./message-state.ts";

export function translateMessageUpdate(
 asst: Record<string, unknown> | undefined,
 state: MessageTranslationState,
 providerOptions?: Record<string, unknown>,
 parentRef?: string,
): ThreadDelta[] {
 if (!asst) return [];
 const deltas = translateReasoningUpdate(asst, state, Boolean(providerOptions?.hideThinking ?? false), parentRef);
 if (asst.type === "text_delta" && typeof asst.delta === "string") {
  if (parentRef) {
   deltas.push({ kind: "item.textDelta", key: { channel: `${parentRef}:agentMessage`, parentRef }, channel: "agentMessage", text: asst.delta });
  } else {
   state.currentAgentText += asst.delta;
   deltas.push({ kind: "item.textDelta", key: { channel: "agentMessage" }, channel: "agentMessage", text: asst.delta });
  }
 }
 return deltas;
}

export function translateMessageEnd(
	msg: { content?: Array<{ type?: string; text?: string }> } | undefined,
	currentAgentText: string,
	openThinkingChannels?: Set<string>,
): { deltas: ThreadDelta[]; nextAgentText: string } {
	const deltas: ThreadDelta[] = [];

	if (openThinkingChannels?.size) {
		for (const channel of openThinkingChannels) {
			deltas.push({ kind: "item.textClose", key: { channel }, channel: "reasoningText", text: "" });
		}
		openThinkingChannels.clear();
	}

	let finalText = currentAgentText;
	if (msg?.content && Array.isArray(msg.content)) {
		const textParts = msg.content
			.filter((p) => p && p.type === "text" && typeof p.text === "string")
			.map((p) => p.text as string);
		if (textParts.length > 0) finalText = textParts.join("");
	}

	if (finalText) {
		deltas.push({
			kind: "item.textClose",
			key: { channel: "agentMessage" },
			channel: "agentMessage",
			text: finalText,
		});
	}
	return { deltas, nextAgentText: "" };
}

export function translateAgentEnd(
	event: RunnerEvent,
	currentAgentText: string,
	turnBoundarySent: boolean,
): { deltas: ThreadDelta[]; turnBoundarySent: boolean } {
	const deltas: ThreadDelta[] = [];
	const rawMsg = event.message ?? (event.messages as unknown[])?.[0];
	const msgObj = typeof rawMsg === "object" && rawMsg !== null
		? (rawMsg as { stopReason?: string; errorMessage?: string })
		: undefined;

	const isInterrupted =
		event.aborted === true ||
		event.stopReason === "aborted" ||
		msgObj?.stopReason === "aborted";

	const isError =
		event.stopReason === "error" ||
		msgObj?.stopReason === "error" ||
		Boolean(event.errorMessage ?? msgObj?.errorMessage);

	const errorMessage = event.errorMessage ?? msgObj?.errorMessage;

	let textToClose = currentAgentText;
	if (!textToClose && isError && !isInterrupted) {
		textToClose = errorMessage ? `⚠️ ${errorMessage}` : "An error occurred during turn generation.";
	}

	if (textToClose) {
		deltas.push({
			kind: "item.textClose",
			key: { channel: "agentMessage" },
			channel: "agentMessage",
			text: textToClose,
		});
	}

	deltas.push(
		...translateAgentEndUsage(
			rawMsg,
			typeof event.contextWindow === "number" ? event.contextWindow : undefined,
			event.cumulativeUsage,
		),
	);

	let boundarySent = turnBoundarySent;
	if (!boundarySent) {
		boundarySent = true;
		let status: "completed" | "failed" | "interrupted" = "completed";
		if (isInterrupted) {
			status = "interrupted";
		} else if (isError) {
			status = "failed";
		}

		deltas.push({
			kind: "turn.boundary",
			status,
			...(isError && errorMessage ? { error: { message: errorMessage } } : {}),
			claimIfIdle: true,
			...(event.providerCheckpointId ? { providerCheckpointId: event.providerCheckpointId } : {}),
		});
	}

	return { deltas, turnBoundarySent: boundarySent };
}

export function translateAgentEndUsage(
	rawMsg: unknown,
	contextWindow?: number,
	cumulativeUsage?: CumulativeUsageMetrics,
): ThreadDelta[] {
	const usage = (rawMsg as { usage?: Record<string, unknown> } | undefined)?.usage;
	if (!usage) return [];

	const inTok = Number(usage.input ?? 0);
	const outTok = Number(usage.output ?? 0);
	const totTok = Number(usage.totalTokens ?? (inTok + outTok));
	const cwSize = typeof contextWindow === "number" && contextWindow > 0 ? contextWindow : 128000;
	const cacheRead = Number(usage.cacheRead ?? 0);
	const cacheWrite = Number(usage.cacheWrite ?? 0);
	const reasoning = Number(usage.reasoning ?? 0);
	const cumCached = cumulativeUsage?.cachedInputTokens ?? cacheRead;

	return [
		{
			kind: "usage",
			modelContextWindow: cwSize,
			last: {
				totalTokens: totTok,
				inputTokens: inTok,
				cachedInputTokens: cacheRead,
				cacheReadInputTokens: cacheRead,
				cacheWriteInputTokens: cacheWrite,
				outputTokens: outTok,
				reasoningOutputTokens: reasoning,
			},
			total: {
				totalTokens: cumulativeUsage?.totalTokens ?? totTok,
				inputTokens: cumulativeUsage?.inputTokens ?? inTok,
				cachedInputTokens: cumCached,
				cacheReadInputTokens: cumCached,
				cacheWriteInputTokens: cumulativeUsage?.cacheWriteInputTokens ?? cacheWrite,
				outputTokens: cumulativeUsage?.outputTokens ?? outTok,
				reasoningOutputTokens: reasoning,
			},
		},
		{
			kind: "contextWindow",
			used: totTok,
			size: cwSize,
			estimated: false,
			attach: "currentOrLast",
		},
	];
}
