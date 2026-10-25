import { normalizeFilePath } from "./diff-utils.ts";
import { isDelegationTool } from "./tool-presentations.ts";

/**
 * Builds the typed thread item shape for a given tool execution.
 */
export function buildToolItemShape(
	toolName: string,
	args: Record<string, unknown>,
	fallbackCwd: string,
): Record<string, unknown> {
	if (toolName === "bash") {
		return {
			type: "command",
			command: typeof args.command === "string" ? args.command : "",
			cwd: typeof args.cwd === "string" ? args.cwd : fallbackCwd,
		};
	}

	if (isDelegationTool(toolName)) {
		let task = typeof args.task === "string" ? args.task : "";
		const name = typeof args.name === "string" ? args.name : "";
		if (!task && Array.isArray(args.agents) && args.agents.length > 0) {
			task = `Graph: ${name || "pipeline"} (${args.agents.length} agents)`;
		}
		const defaultLabel = toolName === "agent_spawn_graph"
			? `Graph: ${name || "pipeline"}`
			: (toolName === "subagent" ? "Subagent delegation" : "Agent delegation");
		const label = task ? (task.length > 80 ? `${task.slice(0, 77)}...` : task) : defaultLabel;
		const childRef = String(args.conversationId || args.childRef || name || (toolName === "subagent" ? "subagent" : "agent"));
		const isBackground = args.background !== false;
		return {
			type: "delegation",
			childRef,
			label,
			background: isBackground,
			summary: task || undefined,
		};
	}

	if (toolName === "write") {
		const filePath = normalizeFilePath(args.path, fallbackCwd);
		const newText = typeof args.content === "string" ? args.content : undefined;
		return {
			type: "fileChange",
			changes: filePath
				? [{ path: filePath, kind: "add", ...(newText !== undefined ? { newText } : {}) }]
				: [],
		};
	}

	if (toolName === "edit") {
		const filePath = normalizeFilePath(args.path, fallbackCwd);
		if (!filePath) {
			return { type: "fileChange", changes: [] };
		}
		return {
			type: "fileChange",
			changes: [{ path: filePath, kind: "update" }],
		};
	}

	return {
		type: "tool",
		tool: toolName,
		server: "pi",
		args,
	};
}
