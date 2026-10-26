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
				return { icon: "Play", colorClass: "text-blue-500", title: "Выполняется" };
			case "waiting":
				return { icon: "Clock", colorClass: "text-amber-500", title: "Ожидает зависимостей" };
			case "sleeping":
				return { icon: "Moon", colorClass: "text-indigo-400", title: "Ожидает таймер" };
			case "completing":
				return { icon: "ArrowDownCircle", colorClass: "text-purple-500", title: "Завершает дочернюю работу" };
			case "pending":
				return { icon: "Clock", colorClass: "text-muted-foreground", title: "В очереди" };
		}
	}

	if (item.receipt) {
		switch (item.receipt.outcome) {
			case "completed":
				return { icon: "Check", colorClass: "text-green-500", title: "Успешно завершено" };
			case "failed":
				return { icon: "XCircle", colorClass: "text-red-500", title: "Ошибка выполнения" };
			case "aborted":
				return { icon: "Slash", colorClass: "text-muted-foreground", title: "Прервано" };
			case "faulted":
				return { icon: "AlertTriangle", colorClass: "text-red-600", title: "Аварийный сбой" };
			case "orphaned":
				return { icon: "HelpCircle", colorClass: "text-amber-600", title: "Осиротевшая задача" };
		}
	}

	return { icon: "Circle", colorClass: "text-muted-foreground", title: "Неизвестно" };
}

function formatDuration(ms?: number): string | null {
	if (ms === undefined || ms < 0) return null;
	if (ms < 1000) return `${Math.round(ms)}мс`;
	return `${(ms / 1000).toFixed(1)}с`;
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
	const duration = formatDuration(item.receipt?.durationMs ?? item.liveNode?.durationMs);
	const hasToolError = Boolean(item.receipt?.isToolError);

	return (
		<div
			role="button"
			tabIndex={0}
			onClick={onSelect}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onSelect();
				}
			}}
			style={{ paddingLeft: `${depth * 16 + 6}px` }}
			className={`group flex items-center gap-1.5 py-1 pr-2 rounded text-xs select-none cursor-pointer transition-colors duration-150 ${
				isSelected
					? "bg-accent/15 text-accent-foreground font-medium"
					: "hover:bg-muted/40 hover:shadow-sm text-foreground"
			}`}
		>
			{hasChildren ? (
				<button
					type="button"
					aria-label={isCollapsed ? "Раскрыть" : "Свернуть"}
					onClick={(e) => {
						e.stopPropagation();
						onToggleCollapse();
					}}
					className="w-4 h-4 flex items-center justify-center text-muted-foreground hover:text-foreground"
				>
					<Icon name={isCollapsed ? "ChevronRight" : "ChevronDown"} className="w-3.5 h-3.5" />
				</button>
			) : (
				<span className="w-4 h-4" />
			)}

			<span title={statusTitle} className={`flex-shrink-0 ${colorClass}`}>
				<Icon name={icon} className="w-3.5 h-3.5" />
			</span>

			<span className="truncate max-w-[220px]" title={item.label}>
				{item.label}
			</span>

			{item.waitingOn && item.waitingOn.length > 0 ? (
				<span className="text-[10px] px-1 py-0.2 bg-amber-500/10 text-amber-600 dark:text-amber-400 rounded">
					ждёт: #{item.waitingOn.join(", #")}
				</span>
			) : null}

			{hasToolError ? (
				<span className="text-[10px] px-1 py-0.2 bg-red-500/10 text-red-600 dark:text-red-400 rounded">
					ошибка инструмента
				</span>
			) : null}

			{item.liveNode?.abortRequested ? (
				<span className="text-[10px] px-1 py-0.2 bg-muted text-muted-foreground rounded">
					отмена
				</span>
			) : null}

			{duration ? (
				<span className="ml-auto text-[10px] text-muted-foreground pl-1 flex-shrink-0">
					{duration}
				</span>
			) : null}
		</div>
	);
};
