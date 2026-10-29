import type { TaskGraphNode, TaskRecord } from "@earendil-works/pi-durable";
import type { TaskTokensUsage } from "../runtime-graph/types.ts";

export function normalizeUsage(raw: unknown): TaskTokensUsage | undefined {
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
 * Strictly requires entryId to match target entry. NEVER silently falls back to another entry (AP-026).
 */
export function extractTerminalTokens(
	task: TaskRecord<unknown, unknown, unknown>,
	current: unknown,
	recentEntries?: ReadonlyMap<number, unknown>,
): TaskTokensUsage | undefined {
	if (task.kind !== "pi.generation") return undefined;

	const state = task.state as any;
	const outcome = state?.outcome;
	const entryId = outcome?.result?.entryId;
	if (entryId === undefined) return undefined;
	const entryIdNum = Number(entryId);

	// 1. Check recent entries captured from commit publication first
	if (recentEntries) {
		const rawEntry = recentEntries.get(entryIdNum) as any;
		const usage = rawEntry?.record?.model?.[0]?.usage ?? rawEntry?.model?.[0]?.usage;
		if (usage) {
			const normalized = normalizeUsage(usage);
			if (normalized) return normalized;
		}
	}

	// 2. Check conversation view entries strictly by entryId
	const cur = current as any;
	const entries = cur?.conversation?.entries;
	if (Array.isArray(entries)) {
		const target = entries.find((e: any) => Number(e?.id) === entryIdNum);
		if (target?.model?.[0]?.usage) {
			return normalizeUsage(target.model[0].usage);
		}
	}

	return undefined;
}
