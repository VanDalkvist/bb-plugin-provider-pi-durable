import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import type { RuntimeGraphSnapshot } from "../../runtime-graph/types.ts";
import { subscribeRuntimeGraph, type RuntimeGraphRealtimeClient } from "./subscription.ts";
import { buildTaskTree, findTreeItem } from "./tree-builder.ts";
import type { RuntimeGraphState, TaskTreeItem } from "./types.ts";

export function useRuntimeGraphState(
	injectedSdk?: RuntimeGraphRealtimeClient,
	threadId?: string,
	conversationId?: number,
): RuntimeGraphState {
	let sdk: RuntimeGraphRealtimeClient | undefined = injectedSdk;
	try {
		if (!sdk) {
			sdk = useSdk() as unknown as RuntimeGraphRealtimeClient;
		}
	} catch {
		// Injected SDK preferred or test environment fallback
	}

	const [status, setStatus] = useState<"loading" | "ok" | "unavailable">("loading");
	const [snapshot, setSnapshot] = useState<RuntimeGraphSnapshot | null>(null);
	const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
	const [collapsedTaskIds, setCollapsedTaskIds] = useState<Set<number>>(new Set());

	const lastEpochRef = useRef<string>("");

	useEffect(() => {
		if (!sdk || !threadId) {
			setStatus("unavailable");
			return;
		}

		setStatus("loading");
		setSnapshot(null);
		setSelectedTaskId(null);
		setCollapsedTaskIds(new Set());
		lastEpochRef.current = "";

		const unsubscribe = subscribeRuntimeGraph(sdk, {
			threadId,
			conversationId,
			onStatusChange: (newStatus) => {
				setStatus(newStatus);
			},
			onSnapshot: (newSnapshot) => {
				const newEpoch = newSnapshot.observation.epoch;
				if (lastEpochRef.current !== "" && lastEpochRef.current !== newEpoch) {
					// Epoch reset (new session or recovery): clear selection
					setSelectedTaskId(null);
				}
				lastEpochRef.current = newEpoch;
				setSnapshot(newSnapshot);
				setStatus("ok");
			},
		});

		return () => {
			unsubscribe();
		};
	}, [sdk, threadId, conversationId]);

	const tree = useMemo(() => {
		return snapshot ? buildTaskTree(snapshot) : [];
	}, [snapshot]);

	const selectedItem = useMemo(() => {
		return findTreeItem(tree, selectedTaskId);
	}, [tree, selectedTaskId]);

	const selectTask = useCallback((id: number | null) => {
		setSelectedTaskId(id);
	}, []);

	const toggleCollapse = useCallback((id: number) => {
		setCollapsedTaskIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	}, []);

	return {
		threadId: threadId ?? "",
		status,
		snapshot,
		tree,
		selectedTaskId,
		selectedItem,
		collapsedTaskIds,
		selectTask,
		toggleCollapse,
	};
}
