import type { RuntimeGraphSnapshot } from "../../runtime-graph/types.ts";
import { subscribeRuntimeGraph, type RuntimeGraphRealtimeClient } from "./subscription.ts";
import { buildTaskTree, findTreeItem } from "./tree-builder.ts";
import type { RuntimeGraphState } from "./types.ts";

export interface RuntimeGraphStore {
	subscribe(listener: () => void): () => void;
	getState(): RuntimeGraphState;
	selectTask(id: number | null): void;
	toggleCollapse(id: number): void;
}

const storeCache = new Map<string, RuntimeGraphStoreImpl>();

class RuntimeGraphStoreImpl implements RuntimeGraphStore {
	private readonly sdk: RuntimeGraphRealtimeClient;
	private readonly threadId: string;
	private readonly conversationId?: number;
	private readonly cacheKey: string;

	private refCount = 0;
	private unsubscribeTransport?: () => void;
	private disposeTimer?: NodeJS.Timeout;
	private readonly listeners = new Set<() => void>();

	private lastEpoch = "";
	private state: RuntimeGraphState;

	constructor(sdk: RuntimeGraphRealtimeClient, threadId: string, conversationId?: number, cacheKey?: string) {
		this.sdk = sdk;
		this.threadId = threadId;
		this.conversationId = conversationId;
		this.cacheKey = cacheKey ?? `${threadId}:${conversationId ?? "root"}`;

		this.state = {
			threadId,
			status: "loading",
			snapshot: null,
			tree: [],
			selectedTaskId: null,
			selectedItem: null,
			collapsedTaskIds: new Set<number>(),
			selectTask: (id) => this.selectTask(id),
			toggleCollapse: (id) => this.toggleCollapse(id),
		};
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		this.refCount++;

		if (this.disposeTimer) {
			clearTimeout(this.disposeTimer);
			this.disposeTimer = undefined;
		}

		if (this.refCount === 1 && !this.unsubscribeTransport) {
			this.startTransport();
		}

		return () => {
			this.listeners.delete(listener);
			this.refCount--;

			if (this.refCount <= 0) {
				this.disposeTimer = setTimeout(() => {
					this.cleanup();
				}, 50);
			}
		};
	}

	getState(): RuntimeGraphState {
		return this.state;
	}

	selectTask(id: number | null): void {
		const selectedItem = findTreeItem(this.state.tree, id);
		this.state = {
			...this.state,
			selectedTaskId: id,
			selectedItem,
		};
		this.notify();
	}

	toggleCollapse(id: number): void {
		const next = new Set(this.state.collapsedTaskIds);
		if (next.has(id)) {
			next.delete(id);
		} else {
			next.add(id);
		}
		this.state = {
			...this.state,
			collapsedTaskIds: next,
		};
		this.notify();
	}

	private startTransport(): void {
		this.unsubscribeTransport = subscribeRuntimeGraph(this.sdk, {
			threadId: this.threadId,
			conversationId: this.conversationId,
			onStatusChange: (status) => {
				this.state = { ...this.state, status };
				this.notify();
			},
			onSnapshot: (snapshot) => {
				const newEpoch = snapshot.observation.epoch;
				let selectedId = this.state.selectedTaskId;
				if (this.lastEpoch !== "" && this.lastEpoch !== newEpoch) {
					selectedId = null;
				}
				this.lastEpoch = newEpoch;

				const tree = buildTaskTree(snapshot);
				const selectedItem = findTreeItem(tree, selectedId);

				this.state = {
					...this.state,
					status: "ok",
					snapshot,
					tree,
					selectedTaskId: selectedId,
					selectedItem,
				};
				this.notify();
			},
		});
	}

	private cleanup(): void {
		if (this.refCount > 0) return;
		if (this.unsubscribeTransport) {
			this.unsubscribeTransport();
			this.unsubscribeTransport = undefined;
		}
		storeCache.delete(this.cacheKey);
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}
}

export function getOrCreateRuntimeGraphStore(
	sdk: RuntimeGraphRealtimeClient,
	threadId: string,
	conversationId?: number,
): RuntimeGraphStore {
	const key = `${threadId}:${conversationId ?? "root"}`;
	const existing = storeCache.get(key);
	if (existing) {
		return existing;
	}
	const store = new RuntimeGraphStoreImpl(sdk, threadId, conversationId, key);
	storeCache.set(key, store);
	return store;
}
