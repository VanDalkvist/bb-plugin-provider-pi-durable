/**
 * Presentation descriptors and title resolvers for provider tools in Beyond Boundaries.
 * Isolates presentation logic from delta mapping to respect file line budgets (AP-019).
 */

export function isDelegationTool(name: string): boolean {
	return name === "subagent" || name === "agent_spawn" || name === "agent_spawn_graph";
}

export function getDelegationPresentation(title: unknown): Record<string, unknown> {
	return {
		label: { pending: "Running subagent", completed: "Subagent completed" },
		icon: { glyph: "Bot" },
		title: String(title ?? "Subagent"),
	};
}

export function extractCodemodeTitle(code?: unknown): string {
	if (typeof code !== "string" || !code.trim()) {
		return "Code execution";
	}
	const lines = code.trim().split("\n");
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) continue;
		if (line.startsWith("// @options:") || line.startsWith("/* @options:")) {
			continue;
		}
		const cleaned = line
			.replace(/^(\/\/|\/\*+|\*+|\/\/!|#)\s*/, "")
			.replace(/\*+\/$/, "")
			.trim();
		if (cleaned.length > 0) {
			return cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned;
		}
	}
	return "Code execution";
}

export function getCodemodePresentation(args?: Record<string, unknown>): Record<string, unknown> {
	const title = extractCodemodeTitle(args?.code);
	return {
		label: { pending: "Running code", completed: "Ran code" },
		icon: { glyph: "Code" },
		title,
	};
}

export function resolveToolPresentation(
	toolName: string,
	shape: Record<string, unknown>,
	args?: Record<string, unknown>,
): Record<string, unknown> | undefined {
	if (shape.type === "delegation") {
		return getDelegationPresentation(shape.label);
	}
	if (toolName === "codemode") {
		return getCodemodePresentation(args);
	}
	return undefined;
}
