export interface NormalizedModelRef {
	provider: string;
	modelId: string;
}

export function normalizeModelReference(raw: unknown, defaultProvider?: string): NormalizedModelRef | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as Record<string, unknown>;
	const provider = typeof r.provider === "string" && r.provider.trim() ? r.provider.trim() : defaultProvider?.trim();
	const rawId =
		typeof r.modelId === "string" && r.modelId.trim()
			? r.modelId.trim()
			: typeof r.id === "string" && r.id.trim()
				? r.id.trim()
				: undefined;

	if (!provider || !rawId) return undefined;
	const prefix = `${provider}/`;
	const cleanModelId = rawId.startsWith(prefix) ? rawId.slice(prefix.length) : rawId;
	return { provider, modelId: cleanModelId };
}

export function formatModelCliArg(ref: { provider: string; modelId: string }): string {
	const normalized = normalizeModelReference(ref);
	if (!normalized) return `${ref.provider}/${ref.modelId}`;
	return `${normalized.provider}/${normalized.modelId}`;
}
