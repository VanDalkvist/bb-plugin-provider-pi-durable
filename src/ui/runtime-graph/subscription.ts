import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import type { RuntimeGraphSnapshot } from "../../runtime-graph/types.ts";
import { readRuntimeGraphSnapshot } from "./read.ts";

export type RuntimeGraphRealtimeClient = Pick<PluginBrowserBbSdk, "subscribe" | "threads">;

export interface SubscribeRuntimeGraphOptions {
	readonly threadId: string;
	readonly conversationId?: number;
	readonly onSnapshot: (snapshot: RuntimeGraphSnapshot) => void;
	readonly onStatusChange?: (status: "ok" | "unavailable" | "loading") => void;
	readonly debounceMs?: number;
	readonly maxDebounceMs?: number;
}

export function subscribeRuntimeGraph(
	sdk: RuntimeGraphRealtimeClient,
	options: SubscribeRuntimeGraphOptions,
): () => void {
	const { threadId, conversationId, onSnapshot, onStatusChange } = options;
	const debounceMs = options.debounceMs ?? 100;
	const maxDebounceMs = Math.max(debounceMs, options.maxDebounceMs ?? 1000);

	if (typeof sdk?.subscribe !== "function") {
		onStatusChange?.("unavailable");
		return () => {};
	}

	let isDisposed = false;
	let inFlight = false;
	let hasPendingFetch = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let firstScheduledAt: number | undefined;
	const abortController = new AbortController();

	let lastEpoch = "";
	let lastRevision = -1;

	const fetchLatest = async () => {
		if (isDisposed) return;
		if (inFlight) {
			hasPendingFetch = true;
			return;
		}
		inFlight = true;
		onStatusChange?.("loading");

		try {
			const result = await readRuntimeGraphSnapshot(sdk, threadId, {
				conversationId,
				signal: abortController.signal,
			});

			if (isDisposed || abortController.signal.aborted) return;

			if (result.status === "ok") {
				const { epoch, revision } = result.snapshot.observation;
				if (lastEpoch !== "" && epoch < lastEpoch) {
					onStatusChange?.("ok");
					return;
				}
				if (epoch === lastEpoch && revision <= lastRevision) {
					onStatusChange?.("ok");
					return;
				}

				lastEpoch = epoch;
				lastRevision = revision;
				onStatusChange?.("ok");
				onSnapshot(result.snapshot);
			} else {
				onStatusChange?.("unavailable");
			}
		} catch {
			if (!isDisposed && !abortController.signal.aborted) {
				onStatusChange?.("unavailable");
			}
		} finally {
			inFlight = false;
			if (hasPendingFetch && !isDisposed) {
				hasPendingFetch = false;
				scheduleFetch();
			}
		}
	};

	const scheduleFetch = () => {
		if (isDisposed) return;
		const now = Date.now();
		if (firstScheduledAt === undefined) firstScheduledAt = now;
		const elapsed = now - firstScheduledAt;

		if (elapsed >= maxDebounceMs) {
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
			firstScheduledAt = undefined;
			void fetchLatest();
			return;
		}

		if (timer !== undefined) clearTimeout(timer);
		const delay = Math.min(debounceMs, maxDebounceMs - elapsed);
		timer = setTimeout(() => {
			timer = undefined;
			firstScheduledAt = undefined;
			void fetchLatest();
		}, Math.max(0, delay));
	};

	void fetchLatest();

	const realtimeUnsub = sdk.subscribe({
		event: "thread:changed",
		threadId,
		callback: () => scheduleFetch(),
	});

	return () => {
		if (isDisposed) return;
		isDisposed = true;
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		firstScheduledAt = undefined;
		hasPendingFetch = false;
		abortController.abort();
		if (typeof realtimeUnsub === "function") {
			realtimeUnsub();
		}
	};
}
