import React, { type FC, useState, useEffect } from "react";
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

const FOLD_THRESHOLD = 5;

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
	const [lastRevealedId, setLastRevealedId] = useState<number | null>(null);

	useEffect(() => {
		if (selectedTaskId === null) {
			if (lastRevealedId !== null) {
				setLastRevealedId(null);
			}
			return;
		}
		if (selectedTaskId !== lastRevealedId) {
			setLastRevealedId(selectedTaskId);
			const toExpand: string[] = [];
			const findBranches = (items: readonly TaskTreeItem[], key: string) => {
				const finished = items.filter((it) => !hasActiveWork(it));
				const summary = getFoldedHistorySummary(finished);
				if (summary.total > FOLD_THRESHOLD && finished.some((it) => hasDescendantId(it, selectedTaskId))) {
					toExpand.push(key);
				}
				for (const it of items) {
					if (it.children.length > 0) {
						findBranches(it.children, `branch-${it.id}`);
					}
				}
			};
			findBranches(tree, "root");
			if (toExpand.length > 0) {
				setExpandedHistory((prev) => {
					const next = new Set(prev);
					for (const k of toExpand) next.add(k);
					return next;
				});
			}
		}
	}, [selectedTaskId, lastRevealedId, tree]);

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

		const finishedSummary = getFoldedHistorySummary(finished);
		const shouldFold = finishedSummary.total > FOLD_THRESHOLD;
		const isHistoryExpanded = !shouldFold || expandedHistory.has(branchKey);

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

				{!shouldFold ? finished.map(renderItemNode) : null}

				{shouldFold && !isHistoryExpanded ? (() => {
					const { total, failed, toolError } = finishedSummary;
					const hasFailure = failed > 0 || toolError > 0;
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
								<span className="w-3.5 h-3.5 flex items-center justify-center text-muted-foreground">
									<Icon name="ChevronDown" className="w-3.5 h-3.5" />
								</span>
								<span>{labelText}</span>
							</button>
						</div>
					);
				})() : null}

				{shouldFold && isHistoryExpanded ? (
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
