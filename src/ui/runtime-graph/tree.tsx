import React, { type FC } from "react";
import type { TaskTreeItem } from "./types.ts";
import { RuntimeGraphNodeRow } from "./node-row.tsx";

export interface RuntimeGraphTreeProps {
	readonly tree: readonly TaskTreeItem[];
	readonly selectedTaskId: number | null;
	readonly collapsedTaskIds: ReadonlySet<number>;
	readonly onSelectTask: (id: number) => void;
	readonly onToggleCollapse: (id: number) => void;
}

export const RuntimeGraphTree: FC<RuntimeGraphTreeProps> = ({
	tree,
	selectedTaskId,
	collapsedTaskIds,
	onSelectTask,
	onToggleCollapse,
}) => {
	if (tree.length === 0) {
		return (
			<div className="flex items-center justify-center h-full p-4 text-xs text-muted-foreground">
				Нет задач в графе
			</div>
		);
	}

	const renderNodes = (items: readonly TaskTreeItem[], depth: number): React.ReactNode => {
		return items.map((item) => {
			const isSelected = selectedTaskId === item.id;
			const isCollapsed = collapsedTaskIds.has(item.id);

			return (
				<React.Fragment key={`task-node-${item.id}`}>
					<RuntimeGraphNodeRow
						item={item}
						depth={depth}
						isSelected={isSelected}
						isCollapsed={isCollapsed}
						onSelect={() => onSelectTask(item.id)}
						onToggleCollapse={() => onToggleCollapse(item.id)}
					/>
					{!isCollapsed && item.children.length > 0
						? renderNodes(item.children, depth + 1)
						: null}
				</React.Fragment>
			);
		});
	};

	return (
		<div className="space-y-0.5 pr-1" tabIndex={-1}>
			{renderNodes(tree, 0)}
		</div>
	);
};
