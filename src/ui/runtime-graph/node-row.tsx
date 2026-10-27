import React, { type FC } from "react";
import { experimental_Icon } from "@get-bb/plugin-sdk/app";
import type { TaskTreeItem } from "./types.ts";

export interface RuntimeGraphNodeRowProps {
	readonly item: TaskTreeItem;
	readonly depth: number;
	readonly isSelected: boolean;
	readonly isCollapsed: boolean;
	readonly onSelect: () => void;
	readonly onToggleCollapse: () => void;
}

function resolveStatusIcon(item: TaskTreeItem): { icon: string; colorClass: string; title: string } {
	if (item.liveNode) {
		switch (item.liveNode.state.status) {
			case "running":
				return { icon: "Play", colorClass: "text-blue-500", title: "Running" };
			case "waiting":
				return { icon: "Clock", colorClass: "text-amber-500", title: "Waiting on dependencies" };
			case "sleeping":
				return { icon: "Moon", colorClass: "text-indigo-400", title: "Waiting for timer" };
			case "completing":
				return { icon: "ArrowDownCircle", colorClass: "text-purple-500", title: "Completing child work" };
			case "pending":
				return { icon: "Clock", colorClass: "text-muted-foreground", title: "Queued" };
		}
	}

	if (item.receipt) {
		switch (item.receipt.outcome) {
			case "completed":
				return { icon: "Check", colorClass: "text-green-500", title: "Completed" };
			case "failed":
				return { icon: "XCircle", colorClass: "text-red-500", title: "Execution failed" };
			case "aborted":
				return { icon: "Slash", colorClass: "text-muted-foreground", title: "Aborted" };
			case "faulted":
				return { icon: "AlertTriangle", colorClass: "text-red-600", title: "Runtime fault" };
			case "orphaned":
				return { icon: "HelpCircle", colorClass: "text-amber-600", title: "Orphaned task" };
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
	item,
	depth,
	isSelected,
	isCollapsed,
	onSelect,
	onToggleCollapse,
}) => {
	const Icon = experimental_Icon;
	const { icon, colorClass, title: statusTitle } = resolveStatusIcon(item);
	const hasChildren = item.children.length > 0;
	const liveElapsed = item.liveNode?.durationMs ?? (
		item.liveNode?.startedAt && item.liveNode.startedAt > 0
			? Math.max(0, Date.now() - item.liveNode.startedAt)
			: undefined
	);
	const duration = formatDuration(item.receipt?.durationMs ?? liveElapsed);
	const hasToolError = Boolean(item.receipt?.isToolError);
	const displayLabel = resolveItemLabel(item);

	return (
		<div
			data-task-id={item.id}
			data-active={!item.isTerminal ? "true" : undefined}
			style={{ paddingLeft: `${depth * 16 + 6}px` }}
			className="group flex items-center gap-1 py-0.5 pr-2 rounded text-xs select-none transition-colors duration-150"
		>
			{hasChildren ? (
				<button
					type="button"
					aria-expanded={!isCollapsed}
					aria-label={isCollapsed ? "Expand" : "Collapse"}
					onClick={onToggleCollapse}
					className="w-4 h-4 flex-shrink-0 flex items-center justify-center text-muted-foreground hover:text-foreground cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded"
				>
					<Icon name={isCollapsed ? "ChevronRight" : "ChevronDown"} className="w-3.5 h-3.5" />
				</button>
			) : (
				<span className="w-4 h-4 flex-shrink-0" />
			)}

			<button
				type="button"
				onClick={onSelect}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						onSelect();
					}
				}}
				aria-pressed={isSelected}
				className={`flex-1 min-w-0 flex items-center gap-1.5 py-1 px-1.5 text-left rounded text-xs select-none cursor-pointer transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
					isSelected
						? "bg-accent/15 text-accent-foreground font-medium"
						: "hover:bg-muted/40 hover:shadow-sm text-foreground"
				}`}
			>
				<span title={statusTitle} className={`flex-shrink-0 ${colorClass}`}>
					<Icon name={icon} className="w-3.5 h-3.5" />
				</span>

				<span className="truncate max-w-[220px]" title={displayLabel}>
					{displayLabel}
				</span>

				{item.waitingOn && item.waitingOn.length > 0 ? (
					<span className="text-[10px] px-1 py-0.2 bg-amber-500/10 text-amber-600 dark:text-amber-400 rounded">
						waits: #{item.waitingOn.join(", #")}
					</span>
				) : null}

				{hasToolError ? (
					<span className="text-[10px] px-1 py-0.2 bg-red-500/10 text-red-600 dark:text-red-400 rounded">
						tool error
					</span>
				) : null}

				{item.liveNode?.abortRequested ? (
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
