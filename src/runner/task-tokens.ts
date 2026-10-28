import type { TaskGraphNode, TaskRecord } from "@earendil-works/pi-durable";
import type { TaskTokensUsage } from "../runtime-graph/types.ts";

function normalizeUsage(raw: unknown): TaskTokensUsage | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const u = raw as Record<string, unknown>;
	const total = typeof u.totalTokens === "number" ? u.totalTokens : (typeof u.total === "number" ? u.total : undefined);
	const input = typeof u.input === "number" ? u.input : (typeof u.inputTokens === "number" ? u.inputTokens : undefined);
	const output = typeof u.output === "number" ? u.output : (typeof u.outputTokens === "number" ? u.outputTokens : undefined);
	const reasoning = typeof u.reasoning === "number" ? u.reasoning : undefined;
	const cacheRead = typeof u.cacheRead === "number" ? u.cacheRead : (typeof u.cachedInputTokens === "number" ? u.cachedInputTokens : undefined);

	const computedTotal = total ?? ((input ?? 0) + (output ?? 0));
	if (computedTotal <= 0 && (output ?? 0) <= 0) return undefined;

	return {
		total: computedTotal,
		input,
		output,
		reasoning,
		cacheRead,
	};
}

/**
 * Extracts live tokens usage for a running task node (specifically pi.generation).
 */
export function extractLiveTokens(node: TaskGraphNode, current: unknown): TaskTokensUsage | undefined {
	if (node.kind !== "pi.generation") return undefined;
	const cur = current as any;
	if (!cur || typeof cur !== "object") return undefined;

	const liveDoc = cur?.conversation?.docs?.["pi.live"];
	if (liveDoc?.generation?.message?.usage) {
		const usage = normalizeUsage(liveDoc.generation.message.usage);
		if (usage) return usage;
	}

	return undefined;
}

/**
 * Extracts terminal tokens usage for a completed task (specifically pi.generation).
 */
export function extractTerminalTokens(
	task: TaskRecord<unknown, unknown, unknown>,
	current: unknown,
): TaskTokensUsage | undefined {
	if (task.kind !== "pi.generation") return undefined;
	const cur = current as any;
	if (!cur || typeof cur !== "object") return undefined;

	const state = task.state as any;
	const outcome = state?.outcome;
	const entryId = outcome?.result?.entryId;

	const entries = cur?.conversation?.entries;
	if (Array.isArray(entries)) {
		if (entryId !== undefined) {
			const target = entries.find((e: any) => e?.id === entryId || Number(e?.id) === Number(entryId));
			if (target?.model?.[0]?.usage) {
				return normalizeUsage(target.model[0].usage);
			}
		}
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e?.kind === "pi.assistant" && e?.model?.[0]?.usage) {
				return normalizeUsage(e.model[0].usage);
			}
		}
	}

	return undefined;
}
