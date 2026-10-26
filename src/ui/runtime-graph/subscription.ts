import type { RuntimeGraphSnapshot } from "../../runtime-graph/types.ts";
import { readRuntimeGraphSnapshot, type RuntimeGraphEventsClient } from "./read.ts";

export interface RuntimeGraphRealtimeClient extends RuntimeGraphEventsClient {
	readonly realtime?: {
		subscribe(args: {
			readonly event: string;
			readonly threadId: string;
			readonly callback: (event: unknown) => void;
		}): () => void;
	};
}

export interface SubscribeRuntimeGraphOptions {
	readonly threadId: string;
	readonly conversationId?: number;
	readonly onSnapshot: (snapshot: RuntimeGraphSnapshot) => void;
	readonly onStatusChange?: (status: "ok" | "unavailable" | "loading") => void;
	readonly debounceMs?: number;
}

export function subscribeRuntimeGraph(
	sdk: RuntimeGraphRealtimeClient,
	options: SubscribeRuntimeGraphOptions,
): () => void {
	const { threadId, conversationId, onSnapshot, onStatusChange } = options;
	const debounceMs = options.debounceMs ?? 100;

	let isDisposed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abortController = new AbortController();

	let lastEpoch = "";
	let lastRevision = -1;

	const fetchLatest = async () => {
		if (isDisposed) return;
		onStatusChange?.("loading");

		const result = await readRuntimeGraphSnapshot(sdk, threadId, {
			conversationId,
			signal: abortController.signal,
		});

		if (isDisposed || abortController.signal.aborted) return;

		if (result.status === "ok") {
			const { epoch, revision } = result.snapshot.observation;
			if (lastEpoch !== "" && epoch < lastEpoch) {
				return;
			}
			if (epoch === lastEpoch && revision <= lastRevision) {
				return;
			}

			lastEpoch = epoch;
			lastRevision = revision;
			onStatusChange?.("ok");
			onSnapshot(result.snapshot);
		} else {
			onStatusChange?.("unavailable");
		}
	};

	const scheduleFetch = () => {
		if (isDisposed) return;
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			void fetchLatest();
		}, debounceMs);
	};

	void fetchLatest();

	const realtimeUnsub = sdk.realtime?.subscribe({
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
		abortController.abort();
		if (typeof realtimeUnsub === "function") {
			realtimeUnsub();
		}
	};
}

