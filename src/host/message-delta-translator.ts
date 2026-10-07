import type { RunnerEvent, ThreadDelta } from "./types.ts";

export const REASONING_PRESENTATION = {
	label: { pending: "Thinking", completed: "Thought" },
	icon: { glyph: "Brain" },
};

export interface MessageTranslationState {
	currentThinkingIndex: number;
	currentAgentText: string;
	openThinkingChannels?: Set<string>;
}

export function translateMessageUpdate(
	asst: Record<string, unknown> | undefined,
	state: MessageTranslationState,
	providerOptions?: Record<string, unknown>,
): ThreadDelta[] {
	if (!asst) return [];
	const deltas: ThreadDelta[] = [];
	const hideThinking = Boolean(providerOptions?.hideThinking ?? false);

	if (asst.type === "thinking_start") {
		const idx = typeof asst.contentIndex === "number" ? asst.contentIndex : state.currentThinkingIndex;
		const channel = `thinking-${idx}`;
		if (!state.openThinkingChannels) {
			state.openThinkingChannels = new Set<string>();
		}
		if (!state.openThinkingChannels.has(channel)) {
			state.openThinkingChannels.add(channel);
			deltas.push({
				kind: "item.open",
				key: { channel },
				item: { type: "reasoning", summary: [], content: [] },
				presentation: {
					...REASONING_PRESENTATION,
					...(hideThinking ? { suppress: true } : {}),
				},
			});
		}
	} else if (asst.type === "thinking_delta" && typeof asst.delta === "string") {
		const idx = typeof asst.contentIndex === "number" ? asst.contentIndex : state.currentThinkingIndex;
		const channel = `thinking-${idx}`;
		if (!state.openThinkingChannels) {
			state.openThinkingChannels = new Set<string>();
		}
		if (!state.openThinkingChannels.has(channel)) {
			state.openThinkingChannels.add(channel);
			deltas.push({
				kind: "item.open",
				key: { channel },
				item: { type: "reasoning", summary: [], content: [] },
				presentation: {
					...REASONING_PRESENTATION,
					...(hideThinking ? { suppress: true } : {}),
				},
			});
		}
		deltas.push({
			kind: "item.textDelta",
			key: { channel },
			channel: "reasoningText",
			text: asst.delta,
		});
	} else if (asst.type === "thinking_end") {
		const idx = typeof asst.contentIndex === "number" ? asst.contentIndex : state.currentThinkingIndex;
		const channel = `thinking-${idx}`;
		deltas.push({
			kind: "item.textClose",
			key: { channel },
			channel: "reasoningText",
			text: (asst.content as string) ?? "",
		});
		state.openThinkingChannels?.delete(channel);
		state.currentThinkingIndex++;
	} else if (asst.type === "text_delta" && typeof asst.delta === "string") {
		if (state.openThinkingChannels && state.openThinkingChannels.size > 0) {
			for (const channel of state.openThinkingChannels) {
				deltas.push({
					kind: "item.textClose",
					key: { channel },
					channel: "reasoningText",
					text: "",
				});
			}
			state.openThinkingChannels.clear();
		}
		state.currentAgentText += asst.delta;
		deltas.push({
			kind: "item.textDelta",
			key: { channel: "agentMessage" },
			channel: "agentMessage",
			text: asst.delta,
		});
	}

	return deltas;
}

export function translateMessageEnd(
	msg: { content?: Array<{ type?: string; text?: string }> } | undefined,
	currentAgentText: string,
	openThinkingChannels?: Set<string>,
): { deltas: ThreadDelta[]; nextAgentText: string } {
	const deltas: ThreadDelta[] = [];

	if (openThinkingChannels && openThinkingChannels.size > 0) {
		for (const channel of openThinkingChannels) {
			deltas.push({
				kind: "item.textClose",
				key: { channel },
				channel: "reasoningText",
				text: "",
			});
		}
		openThinkingChannels.clear();
	}

	let finalText = currentAgentText;
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
	return { deltas, nextAgentText: "" };
}

export function translateAgentEnd(
	event: RunnerEvent,
	currentAgentText: string,
	turnBoundarySent: boolean,
): { deltas: ThreadDelta[]; turnBoundarySent: boolean } {
	const deltas: ThreadDelta[] = [];
	if (currentAgentText) {
		deltas.push({
			kind: "item.textClose",
			key: { channel: "agentMessage" },
			channel: "agentMessage",
			text: currentAgentText,
		});
	}

	const rawMsg = event.message ?? (event.messages as unknown[])?.[0];
	deltas.push(...translateAgentEndUsage(rawMsg, event.contextWindow));

	let boundarySent = turnBoundarySent;
	if (!boundarySent) {
		boundarySent = true;
		deltas.push({
			kind: "turn.boundary",
			status: "completed",
			claimIfIdle: true,
		});
	}

	return { deltas, turnBoundarySent: boundarySent };
}

export function translateAgentEndUsage(
	rawMsg: unknown,
	contextWindow?: number,
): ThreadDelta[] {
	const usage = (rawMsg as { usage?: Record<string, unknown> } | undefined)?.usage;
	if (!usage) return [];

	const inTok = Number(usage.input ?? 0);
	const outTok = Number(usage.output ?? 0);
	const totTok = Number(usage.totalTokens ?? (inTok + outTok));
	const cwSize = typeof contextWindow === "number" && contextWindow > 0 ? contextWindow : 128000;

	return [
		{
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
