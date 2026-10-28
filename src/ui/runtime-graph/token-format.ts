import type { TaskTokensUsage } from "../../runtime-graph/types.ts";

/**
 * Formats token count compactly for task row display (e.g. "450 tok", "1.4k tok", "12k tok").
 */
export function formatTokens(tokens?: number): string | null {
	if (tokens === undefined || tokens === null || tokens <= 0 || !Number.isFinite(tokens)) {
		return null;
	}
	if (tokens < 1000) {
		return `${Math.round(tokens)} tok`;
	}
	if (tokens < 10_000) {
		return `${(tokens / 1000).toFixed(1)}k tok`;
	}
	if (tokens < 1_000_000) {
		return `${Math.round(tokens / 1000)}k tok`;
	}
	return `${(tokens / 1_000_000).toFixed(1)}M tok`;
}

/**
 * Formats a detailed token usage breakdown for the inspector (details panel).
 */
export function formatDetailedTokens(tokens?: TaskTokensUsage): string | null {
	if (!tokens) return null;
	const total = tokens.total ?? ((tokens.input ?? 0) + (tokens.output ?? 0));
	if (total <= 0) return null;

	const parts: string[] = [];
	if (tokens.input !== undefined && tokens.input > 0) {
		parts.push(`${tokens.input.toLocaleString()} in`);
	}
	if (tokens.output !== undefined && tokens.output > 0) {
		parts.push(`${tokens.output.toLocaleString()} out`);
	}
	if (tokens.reasoning !== undefined && tokens.reasoning > 0) {
		parts.push(`${tokens.reasoning.toLocaleString()} reasoning`);
	}
	if (tokens.cacheRead !== undefined && tokens.cacheRead > 0) {
		parts.push(`${tokens.cacheRead.toLocaleString()} cache`);
	}

	const totalStr = `${total.toLocaleString()} total`;
	return parts.length > 0 ? `${totalStr} (${parts.join(" · ")})` : totalStr;
}
