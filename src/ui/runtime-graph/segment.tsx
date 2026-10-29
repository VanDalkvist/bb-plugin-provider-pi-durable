import React, { type FC, useState, useEffect, useRef, useCallback } from "react";
import type { RuntimeGraphState, TaskTreeItem } from "./types.ts";
import { useRuntimeGraphState } from "./use-runtime-graph-state.ts";
import { RuntimeGraphTree } from "./tree.tsx";
import { RuntimeGraphDetails } from "./details.tsx";
import { findBestActiveTaskId } from "./tree-order.ts";
import { useViewClock } from "./use-view-clock.ts";

export interface RuntimeGraphSegmentDetailsProps {
	readonly threadId: string;
	readonly projectId: string;
	readonly environment: unknown | null;
	readonly segments: readonly unknown[];
	readonly isExpanded: boolean;
	readonly onToggle: () => void;
	readonly testState?: RuntimeGraphState;
}

function findAncestorIds(tree: readonly TaskTreeItem[], targetId: number, trail: number[] = []): number[] | null {
	for (const item of tree) {
		if (item.id === targetId) return trail;
		if (item.children.length > 0) {
			const res = findAncestorIds(item.children, targetId, [...trail, item.id]);
			if (res !== null) return res;
		}
	}
	return null;
}

export const RuntimeGraphSegmentDetails: FC<RuntimeGraphSegmentDetailsProps> = ({
	threadId,
	isExpanded,
	testState,
}) => {
	const liveState = useRuntimeGraphState(testState ? null : undefined, threadId);
	const state = testState ?? liveState;

	const containerRef = useRef<HTMLDivElement>(null);
	const treeScrollRef = useRef<HTMLDivElement>(null);
	const hasScrolledInitialRef = useRef(false);
	const [isNarrow, setIsNarrow] = useState(false);

	useEffect(() => {
		const el = containerRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const width = entry.contentRect.width;
				setIsNarrow(width > 0 && width < 580);
			}
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	const { status, snapshot, tree, selectedTaskId, selectedItem, collapsedTaskIds, selectTask, toggleCollapse } = state;
	const latestActiveId = findBestActiveTaskId(tree);
	const now = useViewClock(latestActiveId !== null);

	const scrollToActive = useCallback(() => {
		if (latestActiveId === null) return;
		const ancestors = findAncestorIds(tree, latestActiveId);
		if (ancestors) {
			for (const ancId of ancestors) {
				if (collapsedTaskIds.has(ancId)) {
					toggleCollapse(ancId);
				}
			}
		}

		const container = treeScrollRef.current;
		if (!container) return;
		const activeEl = container.querySelector(`[data-task-id="${latestActiveId}"]`) ??
			container.querySelector('[data-active="true"]');
		if (activeEl && typeof activeEl.scrollIntoView === "function") {
			activeEl.scrollIntoView({ block: "nearest" });
		}
	}, [latestActiveId, tree, collapsedTaskIds, toggleCollapse]);

	useEffect(() => {
		if (!isExpanded) {
			hasScrolledInitialRef.current = false;
			return;
		}
		if (latestActiveId !== null && !hasScrolledInitialRef.current) {
			hasScrolledInitialRef.current = true;
			scrollToActive();
		}
	}, [isExpanded, latestActiveId, scrollToActive]);

	if (!isExpanded) {
		return null;
	}

	if (status === "loading" && !snapshot) {
		return (
			<div className="flex items-center justify-center p-4 bg-transparent text-xs text-muted-foreground">
				Loading task graph...
			</div>
		);
	}

	if (status === "unavailable" && !snapshot) {
		return (
			<div className="flex items-center justify-center p-4 bg-transparent text-xs text-muted-foreground">
				Task graph unavailable
			</div>
		);
	}

	const hasSelection = selectedTaskId !== null && selectedItem !== null;

	return (
		<div
			ref={containerRef}
			data-layout={isNarrow ? "narrow" : "wide"}
			className={`flex ${
				isNarrow ? "flex-col" : "flex-row"
			} w-full bg-transparent overflow-hidden text-xs max-h-64`}
		>
			<div
				className={`flex-1 relative flex flex-col min-w-0 ${
					hasSelection ? (isNarrow ? "border-b border-border min-h-[120px]" : "border-r border-border") : ""
				}`}
			>
				<div
					ref={treeScrollRef}
					className="flex-1 overflow-y-auto px-2 py-1 min-w-0"
				>
					<RuntimeGraphTree
						tree={tree}
						selectedTaskId={selectedTaskId}
						collapsedTaskIds={collapsedTaskIds}
						now={now}
						onSelectTask={selectTask}
						onToggleCollapse={toggleCollapse}
					/>
				</div>
			</div>

			{hasSelection ? (
				<div
					data-testid="runtime-graph-inspector"
					className={`${isNarrow ? "h-40 border-t border-border" : "w-72 max-w-[45%]"} flex-shrink-0 flex flex-col min-w-0 overflow-hidden p-2.5 bg-muted/5`}
				>
					<RuntimeGraphDetails
						selectedItem={selectedItem}
						now={now}
						onClose={() => selectTask(null)}
						onSelectTaskId={selectTask}
					/>
				</div>
			) : null}
		</div>
	);
};
