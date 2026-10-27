/**
 * Presentation descriptors and title resolvers for provider tools in Beyond Boundaries.
 * Isolates presentation logic from delta mapping to respect file line budgets (AP-019).
 */

export interface DelegationPresentationOptions {
	readonly title?: string;
	readonly background?: boolean;
}

export function isDelegationTool(name: string): boolean {
	return name === "subagent" || name === "agent_spawn" || name === "agent_spawn_graph";
}

export function getDelegationPresentation(options: DelegationPresentationOptions): Record<string, unknown> {
	const isBackground = options.background !== false;
	return {
		label: {
			pending: isBackground ? "Starting background subagent" : "Running subagent",
			completed: isBackground ? "Started background subagent" : "Subagent completed",
		},
		icon: { glyph: "Bot" },
		title: options.title || "Subagent",
	};
}

export function resolveToolPresentation(
	toolName: string,
	shape: Record<string, unknown>,
	args?: Record<string, unknown>,
): Record<string, unknown> | undefined {
	if (shape.type === "delegation") {
		return getDelegationPresentation({
			title: typeof shape.label === "string" ? shape.label : undefined,
			background: typeof shape.background === "boolean" ? shape.background : true,
		});
	}
	// Generic tools, including codemode, use BB's built-in tool card.
	return undefined;
}
