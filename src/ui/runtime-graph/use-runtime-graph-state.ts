import { useMemo, useCallback, useSyncExternalStore } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import type { RuntimeGraphRealtimeClient } from "./subscription.ts";
import type { RuntimeGraphState } from "./types.ts";
import { getOrCreateRuntimeGraphStore } from "./store.ts";

const emptyStates = new Map<string, RuntimeGraphState>();

function getEmptyState(threadId?: string): RuntimeGraphState {
	const key = threadId ?? "";
	let cached = emptyStates.get(key);
	if (!cached) {
		cached = {
			threadId: key,
			status: "unavailable",
			snapshot: null,
			tree: [],
			selectedTaskId: null,
			selectedItem: null,
			collapsedTaskIds: new Set(),
			selectTask: () => {},
			toggleCollapse: () => {},
		};
		emptyStates.set(key, cached);
	}
	return cached;
}

function useAppSdk(): RuntimeGraphRealtimeClient {
	return useSdk() as RuntimeGraphRealtimeClient;
}

export function useRuntimeGraphState(
	injectedSdk?: RuntimeGraphRealtimeClient | null,
	threadId?: string,
	conversationId?: number,
): RuntimeGraphState {
	const sdk = injectedSdk === null ? undefined : (injectedSdk ?? useAppSdk());

	const store = useMemo(() => {
		if (!sdk || !threadId) return null;
		return getOrCreateRuntimeGraphStore(sdk, threadId, conversationId);
	}, [sdk, threadId, conversationId]);

	const subscribe = useCallback(
		(onStoreChange: () => void) => {
			if (!store) return () => {};
			return store.subscribe(onStoreChange);
		},
		[store],
	);

	const getSnapshot = useCallback(() => {
		if (!store) return getEmptyState(threadId);
		return store.getState();
	}, [store, threadId]);

	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
