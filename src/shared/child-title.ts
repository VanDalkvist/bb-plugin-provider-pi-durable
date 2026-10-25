/**
 * Sanitizes and bounds subagent thread titles for Beyond Boundaries Core.
 * Protects Core's 500-char column limit in threads.title (<= 494 UTF-16 units).
 */
export function nativeChildTitle(
	name: string,
	role?: string,
	model?: { provider?: string; modelId?: string },
): string {
	const part = (value: string, limit: number): string =>
		Array.from(
			value
				.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu, " ")
				.replace(/\s+/gu, " ")
				.trim(),
		)
			.slice(0, limit)
			.join("");

	const parts = [part(name, 180)];
	if (role) {
		const r = part(role, 24);
		if (r) parts.push(r);
	}
	const modelLabel = [model?.provider, model?.modelId].filter(Boolean).join("/");
	if (modelLabel) {
		const m = part(modelLabel, 40);
		if (m) parts.push(m);
	}
	return parts.filter(Boolean).join(" · ");
}
