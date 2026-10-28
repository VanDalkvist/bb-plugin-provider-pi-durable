import React, { type FC } from "react";
import { experimental_Icon } from "@get-bb/plugin-sdk/app";
import type { TaskTreeItem } from "./types.ts";

export interface RuntimeGraphNodeRowProps {
	readonly item: TaskTreeItem;
	readonly singleChild?: TaskTreeItem;
	readonly depth: number;
	readonly isSelected: boolean;
	readonly isCollapsed: boolean;
	readonly now?: number;
	readonly onSelect: () => void;
	readonly onSelectChild?: () => void;
	readonly onToggleCollapse: () => void;
}

function resolveStatusIcon(item: TaskTreeItem): { icon: string; colorClass: string; title: string } {
	if (item.liveNode) {
		switch (item.liveNode.state.status) {
			case "running": return { icon: "Play", colorClass: "text-blue-500", title: "Running" };
			case "waiting": return { icon: "Clock", colorClass: "text-amber-500", title: "Waiting on dependencies" };
			case "sleeping": return { icon: "Moon", colorClass: "text-indigo-400", title: "Waiting for timer" };
			case "completing": return { icon: "ArrowDownCircle", colorClass: "text-purple-500", title: "Completing child work" };
			case "pending": return { icon: "Clock", colorClass: "text-muted-foreground", title: "Queued" };
		}
	}
	if (item.receipt) {
		switch (item.receipt.outcome) {
			case "completed": return { icon: "Check", colorClass: "text-green-500", title: "Completed" };
			case "failed": return { icon: "XCircle", colorClass: "text-red-500", title: "Execution failed" };
			case "aborted": return { icon: "Slash", colorClass: "text-muted-foreground", title: "Aborted" };
			case "faulted": return { icon: "AlertTriangle", colorClass: "text-red-600", title: "Runtime fault" };
			case "orphaned": return { icon: "HelpCircle", colorClass: "text-amber-600", title: "Orphaned task" };
		}
	}
	return { icon: "Circle", colorClass: "text-muted-foreground", title: "Unknown" };
}

function formatDuration(ms?: number): string | null {
	if (ms === undefined || ms < 0) return null;
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function resolveItemLabel(item: TaskTreeItem): string {
	const tool = item.liveNode?.toolName ?? item.receipt?.toolName;
	const target = item.liveNode?.targetHint ?? item.receipt?.targetHint;
	if (tool && (item.label.startsWith("pi.tool") || item.label === item.kind)) {
		return target ? `${tool}: ${target}` : tool;
	}
	return item.label;
}

export const RuntimeGraphNodeRow: FC<RuntimeGraphNodeRowProps> = ({
	item, singleChild, depth, isSelected, isCollapsed, now,
	onSelect, onSelectChild, onToggleCollapse,
}) => {
	const Icon = experimental_Icon;
	const effectiveIconItem = (singleChild && (!singleChild.isTerminal || singleChild.receipt?.outcome !== "completed" || Boolean(singleChild.receipt?.isToolError)))
		? singleChild : item;
	const { icon, colorClass, title: statusTitle } = resolveStatusIcon(effectiveIconItem);
	const hasChildren = !singleChild && item.children.length > 0;

	const liveElapsed = (item.liveNode?.startedAt && item.liveNode.startedAt > 0
		? Math.max(0, (now ?? Date.now()) - item.liveNode.startedAt)
		: item.liveNode?.durationMs);
	const duration = formatDuration(item.receipt?.durationMs ?? singleChild?.receipt?.durationMs ?? liveElapsed);

	const hasToolError = Boolean(item.receipt?.isToolError) || Boolean(singleChild?.receipt?.isToolError);
	const waitingOn = (item.waitingOn && item.waitingOn.length > 0) ? item.waitingOn : singleChild?.waitingOn;
	const isAborted = Boolean(item.liveNode?.abortRequested) || Boolean(singleChild?.liveNode?.abortRequested);

	const handleRowClick = () => {
		if (singleChild && onSelectChild) onSelectChild();
		else onSelect();
	};

	return (
		<div
			data-task-id={item.id}
			data-active={(!item.isTerminal || (singleChild && !singleChild.isTerminal)) ? "true" : undefined}
			style={{ paddingLeft: `${depth * 16 + 6}px` }}
			onClick={(e) => {
				if ((e.target as HTMLElement).closest?.("button")) return;
				handleRowClick();
			}}
			className="group flex items-center gap-1 py-0.5 pr-2 rounded text-xs select-none transition-colors duration-150 cursor-pointer"
		>
			{hasChildren ? (
				<button
					type="button"
					aria-expanded={!isCollapsed}
					aria-label={isCollapsed ? "Expand" : "Collapse"}
					onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}
					className="w-4 h-4 flex-shrink-0 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-state-hover cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded"
				>
					<Icon name={isCollapsed ? "ChevronRight" : "ChevronDown"} className="w-3.5 h-3.5" />
				</button>
			) : (
				<span className="w-4 h-4 flex-shrink-0" />
			)}

			<button
				type="button"
				onClick={(e) => { e.stopPropagation(); handleRowClick(); }}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						handleRowClick();
					}
				}}
				aria-pressed={isSelected}
				className={`flex-1 min-w-0 flex items-center gap-1.5 py-0.5 px-1.5 text-left rounded text-xs select-none cursor-pointer transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
					isSelected ? "bg-state-active text-foreground font-medium" : "hover:bg-state-hover text-foreground"
				}`}
			>
				<span title={statusTitle} className={`flex-shrink-0 ${colorClass}`}>
					<Icon name={icon} className="w-3.5 h-3.5" />
				</span>

				{singleChild ? (
					<>
						<span
							title={resolveItemLabel(item)}
							onClick={(e) => { e.stopPropagation(); onSelect(); }}
							className="truncate max-w-[120px] hover:underline cursor-pointer"
						>
							{resolveItemLabel(item)}
						</span>
						<span className="text-muted-foreground flex-shrink-0 select-none">›</span>
						<span
							data-task-id={singleChild.id}
							title={resolveItemLabel(singleChild)}
							onClick={(e) => {
								e.stopPropagation();
								if (onSelectChild) onSelectChild();
								else onSelect();
							}}
							className="truncate max-w-[170px] font-medium hover:underline cursor-pointer"
						>
							{resolveItemLabel(singleChild)}
						</span>
					</>
				) : (
					<>
						<span className="truncate max-w-[220px]" title={resolveItemLabel(item)}>
							{resolveItemLabel(item)}
						</span>
						{item.children.length >= 2 ? (
							<span className="text-[10px] text-muted-foreground flex-shrink-0">
								({item.children.length} tasks)
							</span>
						) : null}
					</>
				)}

				{waitingOn && waitingOn.length > 0 ? (
					<span className="text-[10px] px-1 py-0.2 bg-amber-500/10 text-amber-600 dark:text-amber-400 rounded">
						waits: #{waitingOn.join(", #")}
					</span>
				) : null}

				{hasToolError ? (
					<span className="text-[10px] px-1 py-0.2 bg-red-500/10 text-red-600 dark:text-red-400 rounded">
						tool error
					</span>
				) : null}

				{isAborted ? (
					<span className="text-[10px] px-1 py-0.2 bg-muted text-muted-foreground rounded">
						aborted
					</span>
				) : null}

				{duration ? (
					<span className="ml-auto text-[10px] text-muted-foreground pl-1 flex-shrink-0">
						{duration}
					</span>
				) : null}
			</button>
		</div>
	);
};
