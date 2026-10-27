import type { TaskTreeItem } from "../../src/ui/runtime-graph/types.ts";

export function makeTask(
	id: number,
	isTerminal: boolean,
	outcome?: string,
	children: TaskTreeItem[] = [],
	isToolError = false,
): TaskTreeItem {
	return {
		id,
		kind: "pi.tool",
		label: `Task #${id}`,
		conversationId: 1,
		isTerminal,
		liveNode: isTerminal
			? undefined
			: ({
					id,
					kind: "pi.tool",
					conversationId: 1,
					background: false,
					abortRequested: false,
					state: { status: "running" },
					label: `Task #${id}`,
				} as any),
		receipt: isTerminal
			? ({
					taskId: id,
					kind: "pi.tool",
					conversationId: 1,
					outcome: outcome ?? "completed",
					isToolError,
					durationMs: 120,
				} as any)
			: undefined,
		children,
	};
}
