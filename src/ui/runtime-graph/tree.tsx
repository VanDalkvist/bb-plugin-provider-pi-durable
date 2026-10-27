import React, { type FC, useState } from "react";
import { experimental_Icon } from "@get-bb/plugin-sdk/app";
import type { TaskTreeItem } from "./types.ts";
import { RuntimeGraphNodeRow } from "./node-row.tsx";
import {
	hasActiveWork,
	hasDescendantId,
	getFoldedHistorySummary,
} from "./tree-order.ts";

export interface RuntimeGraphTreeProps {
	readonly tree: readonly TaskTreeItem[];
	readonly selectedTaskId: number | null;
	readonly collapsedTaskIds: ReadonlySet<number>;
	readonly now?: number;
	readonly onSelectTask: (id: number) => void;
	readonly onToggleCollapse: (id: number) => void;
}

export const RuntimeGraphTree: FC<RuntimeGraphTreeProps> = ({
	tree,
	selectedTaskId,
	collapsedTaskIds,
	now,
	onSelectTask,
	onToggleCollapse,
}) => {
	const Icon = experimental_Icon;
	const [expandedHistory, setExpandedHistory] = useState<ReadonlySet<string>>(() => new Set());

	if (tree.length === 0) {
		return (
			<div className="flex items-center justify-center h-full p-4 text-xs text-muted-foreground">
				No tasks in graph
			</div>
		);
	}

	const toggleHistory = (branchKey: string) => {
		setExpandedHistory((prev) => {
			const next = new Set(prev);
			if (next.has(branchKey)) {
				next.delete(branchKey);
			} else {
				next.add(branchKey);
			}
			return next;
		});
	};

	const renderBranch = (items: readonly TaskTreeItem[], depth: number, branchKey: string): React.ReactNode => {
		const active: TaskTreeItem[] = [];
		const finished: TaskTreeItem[] = [];

		for (const item of items) {
			if (hasActiveWork(item)) {
				active.push(item);
			} else {
				finished.push(item);
			}
		}

		active.sort((a, b) => a.id - b.id);
		finished.sort((a, b) => a.id - b.id);

		const isSelectedInFinished = selectedTaskId !== null &&
			finished.some((item) => hasDescendantId(item, selectedTaskId));
		const isHistoryExpanded = isSelectedInFinished || expandedHistory.has(branchKey);

		const renderItemNode = (item: TaskTreeItem) => {
			const isSelected = selectedTaskId === item.id;
			const isCollapsed = collapsedTaskIds.has(item.id);
			const childBranchKey = `branch-${item.id}`;

			return (
				<React.Fragment key={`task-node-${item.id}`}>
					<RuntimeGraphNodeRow
						item={item}
						depth={depth}
						isSelected={isSelected}
						isCollapsed={isCollapsed}
						now={now}
						onSelect={() => onSelectTask(item.id)}
						onToggleCollapse={() => onToggleCollapse(item.id)}
					/>
					{!isCollapsed && item.children.length > 0
						? renderBranch(item.children, depth + 1, childBranchKey)
						: null}
				</React.Fragment>
			);
		};

		return (
			<React.Fragment key={branchKey}>
				{active.map(renderItemNode)}

				{finished.length > 0 && !isHistoryExpanded ? (() => {
					const { total, failed, toolError } = getFoldedHistorySummary(finished);
					const hasFailure = failed > 0 || toolError > 0;
					const iconName = failed > 0 ? "AlertTriangle" : (toolError > 0 ? "AlertTriangle" : "ChevronDown");
					const iconColor = failed > 0 ? "text-red-500" : (toolError > 0 ? "text-amber-500" : "text-muted-foreground");
					const labelText = failed > 0
						? `See more (${total} · ${failed} failed)`
						: (toolError > 0 ? `See more (${total} · ${toolError} tool error)` : `See more (${total})`);

					return (
						<div
							key={`${branchKey}-see-more`}
							style={{ paddingLeft: `${depth * 16 + 24}px` }}
							className="py-0.5 pr-2"
						>
							<button
								type="button"
								data-history-toggle="true"
								data-has-failure={hasFailure ? "true" : undefined}
								onClick={() => toggleHistory(branchKey)}
								className="flex items-center gap-1.5 py-0.5 px-1.5 rounded text-xs select-none transition-colors duration-150 text-muted-foreground hover:bg-state-hover hover:text-foreground cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
							>
								<span className={`w-3.5 h-3.5 flex items-center justify-center ${iconColor}`}>
									<Icon name={iconName} className="w-3.5 h-3.5" />
								</span>
								<span>{labelText}</span>
							</button>
						</div>
					);
				})() : null}

				{finished.length > 0 && isHistoryExpanded ? (
					<>
						{finished.map(renderItemNode)}
						<div
							key={`${branchKey}-see-less`}
							style={{ paddingLeft: `${depth * 16 + 24}px` }}
							className="py-0.5 pr-2"
						>
							<button
								type="button"
								data-history-toggle="true"
								onClick={() => toggleHistory(branchKey)}
								className="flex items-center gap-1.5 py-0.5 px-1.5 rounded text-xs select-none transition-colors duration-150 text-muted-foreground hover:bg-state-hover hover:text-foreground cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
							>
								<span className="w-3.5 h-3.5 flex items-center justify-center text-muted-foreground">
									<Icon name="ChevronUp" className="w-3.5 h-3.5" />
								</span>
								<span>See less</span>
							</button>
						</div>
					</>
				) : null}
			</React.Fragment>
		);
	};

	return (
		<div className="space-y-0.5 pr-1" tabIndex={-1}>
			{renderBranch(tree, 0, "root")}
		</div>
	);
};
