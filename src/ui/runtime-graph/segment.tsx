import React, { type FC } from "react";
import type { RuntimeGraphState } from "./types.ts";
import { useRuntimeGraphState } from "./use-runtime-graph-state.ts";
import { RuntimeGraphTree } from "./tree.tsx";
import { RuntimeGraphDetails } from "./details.tsx";

export interface RuntimeGraphSegmentDetailsProps {
	readonly threadId: string;
	readonly projectId: string;
	readonly environment: unknown | null;
	readonly segments: readonly unknown[];
	readonly isExpanded: boolean;
	readonly onToggle: () => void;
	readonly testState?: RuntimeGraphState;
}

export const RuntimeGraphSegmentDetails: FC<RuntimeGraphSegmentDetailsProps> = ({
	threadId,
	isExpanded,
	testState,
}) => {
	const liveState = useRuntimeGraphState(undefined, threadId);
	const state = testState ?? liveState;

	if (!isExpanded) {
		return null;
	}

	const { status, snapshot, tree, selectedTaskId, selectedItem, collapsedTaskIds, selectTask, toggleCollapse } = state;

	if (status === "loading" && !snapshot) {
		return (
			<div className="flex items-center justify-center p-6 border rounded-md bg-background text-xs text-muted-foreground">
				Загрузка графа задач...
			</div>
		);
	}

	if (status === "unavailable" && !snapshot) {
		return (
			<div className="flex items-center justify-center p-6 border rounded-md bg-background text-xs text-muted-foreground">
				Граф задач недоступен
			</div>
		);
	}

	return (
		<div className="border rounded-md bg-background flex flex-row h-80 max-h-96 overflow-hidden text-sm shadow-sm my-1">
			<div className="flex-1 overflow-y-auto p-2 border-r min-w-0">
				<RuntimeGraphTree
					tree={tree}
					selectedTaskId={selectedTaskId}
					collapsedTaskIds={collapsedTaskIds}
					onSelectTask={selectTask}
					onToggleCollapse={toggleCollapse}
				/>
			</div>

			<div className="w-80 flex-shrink-0 overflow-y-auto p-3 bg-muted/10">
				<RuntimeGraphDetails selectedItem={selectedItem} />
			</div>
		</div>
	);
};
