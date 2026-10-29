import React, { type FC, useState, useEffect, useMemo } from "react";
import { experimental_Icon } from "@get-bb/plugin-sdk/app";
import type { TaskTreeItem } from "./types.ts";
import { RuntimeGraphNodeRow } from "./node-row.tsx";
import { hasActiveWork, hasDescendantId } from "./tree-order.ts";
import { computePreviewFinishedIds, getHiddenBreakdown } from "./tree-preview.ts";

export interface RuntimeGraphTreeProps {
	readonly tree: readonly TaskTreeItem[];
	readonly selectedTaskId: number | null;
	readonly collapsedTaskIds: ReadonlySet<number>;
	readonly now?: number;
	readonly onSelectTask: (id: number) => void;
	readonly onToggleCollapse: (id: number) => void;
}

const FOLD_THRESHOLD = 5;

const HistoryToggle: FC<{
	readonly depth: number;
	readonly label: string;
	readonly isExpanded: boolean;
	readonly hasFailure?: boolean;
	readonly onToggle: () => void;
}> = ({ depth, label, isExpanded, hasFailure, onToggle }) => {
	const Icon = experimental_Icon;
	return (
		<div style={{ paddingLeft: `${depth * 16 + 24}px` }} className="py-0.5 pr-2">
			<button
				type="button"
				data-history-toggle="true"
				data-has-failure={hasFailure ? "true" : undefined}
				onClick={onToggle}
				className="flex items-center gap-1.5 py-0.5 px-1.5 rounded text-xs select-none transition-colors duration-150 text-muted-foreground hover:bg-state-hover hover:text-foreground cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
			>
				<span className="w-3.5 h-3.5 flex items-center justify-center text-muted-foreground">
					<Icon name={isExpanded ? "ChevronUp" : "ChevronDown"} className="w-3.5 h-3.5" />
				</span>
				<span>{label}</span>
			</button>
		</div>
	);
};

export const RuntimeGraphTree: FC<RuntimeGraphTreeProps> = ({
	tree,
	selectedTaskId,
	collapsedTaskIds,
	now,
	onSelectTask,
	onToggleCollapse,
}) => {
	const [expandedHistory, setExpandedHistory] = useState<ReadonlySet<string>>(() => new Set());
	const [lastRevealedId, setLastRevealedId] = useState<number | null>(null);

	const previewFinishedIds = useMemo(
		() => computePreviewFinishedIds(tree, FOLD_THRESHOLD),
		[tree],
	);

	useEffect(() => {
		if (selectedTaskId === null) {
			if (lastRevealedId !== null) setLastRevealedId(null);
			return;
		}
		if (selectedTaskId !== lastRevealedId) {
			setLastRevealedId(selectedTaskId);
			const finishedRoots = tree.filter((it) => !hasActiveWork(it));
			const breakdown = getHiddenBreakdown(finishedRoots, previewFinishedIds);
			if (breakdown.total > 0 && finishedRoots.some((it) => hasDescendantId(it, selectedTaskId))) {
				setExpandedHistory((prev) => new Set([...prev, "root"]));
			}
		}
	}, [selectedTaskId, lastRevealedId, tree, previewFinishedIds]);

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
			if (next.has(branchKey)) next.delete(branchKey);
			else next.add(branchKey);
			return next;
		});
	};

	const renderBranch = (
		items: readonly TaskTreeItem[],
		depth: number,
		branchKey: string,
	): React.ReactNode => {
		const active: TaskTreeItem[] = [];
		const finished: TaskTreeItem[] = [];

		for (const item of items) {
			if (hasActiveWork(item)) active.push(item);
			else finished.push(item);
		}
		active.sort((a, b) => b.id - a.id);
		finished.sort((a, b) => b.id - a.id);

		const isRoot = depth === 0;
		const hiddenBreakdown = isRoot
			? getHiddenBreakdown(finished, previewFinishedIds)
			: { total: 0, hasFailure: false, label: "" };
		const shouldFold = isRoot && hiddenBreakdown.total > 0;
		const isHistoryExpanded = expandedHistory.has(branchKey);

		const renderItemNode = (item: TaskTreeItem) => {
			const isGeneration = item.kind === "pi.generation" ||
				item.label.startsWith("assistant turn") ||
				item.label.startsWith("pi.generation");
			const hasSingleChild = isGeneration && item.children.length === 1;
			const singleChild = hasSingleChild ? item.children[0] : undefined;
			const isMultiChild = item.children.length >= (hasSingleChild ? 2 : 1);

			const defaultCollapsed = !hasActiveWork(item);
			const isCollapsed = isMultiChild
				? (defaultCollapsed ? !collapsedTaskIds.has(item.id) : collapsedTaskIds.has(item.id))
				: false;

			const isSelected = selectedTaskId === item.id ||
				(singleChild !== undefined && selectedTaskId === singleChild.id);

			return (
				<React.Fragment key={`task-node-${item.id}`}>
					<RuntimeGraphNodeRow
						item={item}
						singleChild={singleChild}
						depth={depth}
						isSelected={isSelected}
						isCollapsed={isCollapsed}
						now={now}
						onSelect={() => onSelectTask(item.id)}
						onSelectChild={singleChild ? () => onSelectTask(singleChild.id) : undefined}
						onToggleCollapse={() => onToggleCollapse(item.id)}
					/>
					{isMultiChild && !isCollapsed
						? renderBranch(item.children, depth + 1, `branch-${item.id}`)
						: null}
				</React.Fragment>
			);
		};

		return (
			<React.Fragment key={branchKey}>
				{active.map(renderItemNode)}
				{!shouldFold ? finished.map(renderItemNode) : null}
				{shouldFold && !isHistoryExpanded ? (
					<>
						{finished.filter((it) => previewFinishedIds.has(it.id)).map(renderItemNode)}
						<HistoryToggle
							depth={depth}
							label={hiddenBreakdown.label}
							isExpanded={false}
							hasFailure={hiddenBreakdown.hasFailure}
							onToggle={() => toggleHistory(branchKey)}
						/>
					</>
				) : null}
				{shouldFold && isHistoryExpanded ? (
					<>
						{finished.map(renderItemNode)}
						<HistoryToggle
							depth={depth}
							label="See less"
							isExpanded={true}
							onToggle={() => toggleHistory(branchKey)}
						/>
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
