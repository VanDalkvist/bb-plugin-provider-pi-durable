import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "../setup-dom.ts";
import type { RuntimeGraphSnapshot } from "../../src/runtime-graph/types.ts";
import { getOrCreateRuntimeGraphStore } from "../../src/ui/runtime-graph/store.ts";

setupDom();

function createMockSnapshot(overrides?: Partial<RuntimeGraphSnapshot>): RuntimeGraphSnapshot {
	return {
		version: 1,
		scope: { sessionId: "s-1", rootConversationId: "1", buildId: "b-1" },
		observation: { epoch: "epoch-1", revision: 1, observedAt: 1000, completeness: "complete" },
		nodes: {
			"1": {
				id: 1, kind: "pi.generation", conversationId: 1,
				background: false, abortRequested: false,
				state: { status: "running" }, label: "Task 1",
			},
		},
		conversations: { "1": { id: 1 } },
		receipts: [],
		stats: { liveCount: 1, terminalCount: 0, totalCount: 1 },
		...overrides,
	};
}

test("D2 RED: shared store refcounts and creates exactly ONE transport subscription for same thread", async () => {
	let subscriptionCalls = 0;
	let unsubscribeCalls = 0;
	let realtimeCallback: ((event: unknown) => void) | undefined;
	const snapshot = createMockSnapshot();

	const mockSdk: any = {
		threads: {
			events: {
				list: async () => {
					subscriptionCalls++;
					return [{ kind: "provider-pi-durable/runtime-graph", payload: snapshot, seq: 1 }];
				},
			},
		},
		realtime: {
			subscribe: (args: any) => {
				realtimeCallback = args.callback;
				return () => {
					unsubscribeCalls++;
				};
			},
		},
	};

	const store1 = getOrCreateRuntimeGraphStore(mockSdk, "thread-shared-1");
	const store2 = getOrCreateRuntimeGraphStore(mockSdk, "thread-shared-1");

	assert.equal(store1, store2, "Both store handles must be the exact same instance");

	// Subscriber 1 (e.g. Summary) mounts
	const unsub1 = store1.subscribe(() => {});
	await new Promise((r) => setTimeout(r, 60));

	assert.equal(subscriptionCalls, 1, "Exactly one REST fetch on first subscriber");

	// Subscriber 2 (e.g. Details expanded) mounts
	const unsub2 = store2.subscribe(() => {});
	await new Promise((r) => setTimeout(r, 20));

	assert.equal(subscriptionCalls, 1, "No duplicate REST scan when second subscriber mounts");

	// Selection in store is shared
	store2.selectTask(1);
	assert.equal(store1.getState().selectedTaskId, 1, "Selection must be shared between store handles");

	// Subscriber 2 unmounts (Details collapsed)
	unsub2();
	assert.equal(unsubscribeCalls, 0, "Transport must NOT close while Subscriber 1 is still active");
	assert.equal(store1.getState().selectedTaskId, 1, "Selection must NOT be lost on collapse");

	// Subscriber 1 unmounts (leaving thread)
	unsub1();
	await new Promise((r) => setTimeout(r, 60)); // allow disposal grace/cleanup
	assert.ok(unsubscribeCalls >= 1, "Transport must be disposed after all subscribers unmount");
});
