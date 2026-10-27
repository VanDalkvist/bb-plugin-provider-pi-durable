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

export function resolveToolPresentation(
	toolName: string,
	shape: Record<string, unknown>,
	args?: Record<string, unknown>,
): Record<string, unknown> | undefined {
	if (shape.type === "delegation") {
		return getDelegationPresentation(shape.label);
	}
	// Generic tools, including codemode, use BB's built-in tool card.
	return undefined;
}
