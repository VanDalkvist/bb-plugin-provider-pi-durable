import test from "node:test";
import assert from "node:assert/strict";
import { subscribeRuntimeGraph } from "../src/ui/runtime-graph/subscription.ts";
import type { RuntimeGraphSnapshot } from "../src/runtime-graph/types.ts";

function makeSnapshot(epoch: string, revision: number): RuntimeGraphSnapshot {
	return {
		version: 1,
		scope: { sessionId: "s1", rootConversationId: "1", buildId: "b1" },
		observation: { epoch, revision, observedAt: 1000 + revision, completeness: "complete" },
		nodes: {},
		conversations: { "1": { id: 1 } },
		receipts: [],
		stats: { liveCount: 0, terminalCount: 0, totalCount: 0 },
	};
}

function createRealtimeMockSdk(eventsSequence: any[]) {
	let eventIndex = 0;
	let realtimeCallback: ((event: any) => void) | undefined;
	let unsubscribeCalled = false;

	return {
		threads: {
			events: {
				list: async () => {
					const event = eventsSequence[eventIndex] ?? eventsSequence[eventsSequence.length - 1];
					return event ? [event] : [];
				},
			},
		},
		realtime: {
			subscribe: (args: { event: string; threadId: string; callback: (e: any) => void }) => {
				realtimeCallback = args.callback;
				return () => {
					unsubscribeCalled = true;
				};
			},
		},
		triggerRealtime: (nextIndex: number) => {
			eventIndex = nextIndex;
			realtimeCallback?.({ event: "thread:changed", threadId: "thr_1" });
		},
		isUnsubscribed: () => unsubscribeCalled,
	};
}

test("runtime-graph-reconnect: fetches initial snapshot and updates on thread:changed", async () => {
	const snap1 = makeSnapshot("epoch_1", 1);
	const snap2 = makeSnapshot("epoch_1", 2);

	const mockSdk = createRealtimeMockSdk([
		{
			type: "thread/extensionState/updated",
			kind: "provider-pi-durable/runtime-graph",
			payload: snap1,
			threadId: "thr_1",
			seq: 1,
		},
		{
			type: "thread/extensionState/updated",
			kind: "provider-pi-durable/runtime-graph",
			payload: snap2,
			threadId: "thr_1",
			seq: 2,
		},
	]);

	const received: RuntimeGraphSnapshot[] = [];
	const unsubscribe = subscribeRuntimeGraph(mockSdk as any, {
		threadId: "thr_1",
		onSnapshot: (s) => received.push(s),
		debounceMs: 10,
	});

	// Wait for initial fetch
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(received.length, 1);
	assert.equal(received[0]?.observation.revision, 1);

	// Trigger realtime thread:changed to advance to snap2
	mockSdk.triggerRealtime(1);
	await new Promise((r) => setTimeout(r, 40));

	assert.equal(received.length, 2);
	assert.equal(received[1]?.observation.revision, 2);

	unsubscribe();
	assert.equal(mockSdk.isUnsubscribed(), true);
});

test("runtime-graph-reconnect: drops stale/reordered revisions from earlier epoch", async () => {
	const snapV2 = makeSnapshot("epoch_2", 1);
	const snapV1 = makeSnapshot("epoch_1", 10); // older epoch, but higher revision number

	const mockSdk = createRealtimeMockSdk([
		{
			type: "thread/extensionState/updated",
			kind: "provider-pi-durable/runtime-graph",
			payload: snapV2,
			threadId: "thr_1",
			seq: 2,
		},
		{
			type: "thread/extensionState/updated",
			kind: "provider-pi-durable/runtime-graph",
			payload: snapV1, // stale older epoch!
			threadId: "thr_1",
			seq: 3,
		},
	]);

	const received: RuntimeGraphSnapshot[] = [];
	const unsubscribe = subscribeRuntimeGraph(mockSdk as any, {
		threadId: "thr_1",
		onSnapshot: (s) => received.push(s),
		debounceMs: 10,
	});

	await new Promise((r) => setTimeout(r, 30));
	assert.equal(received.length, 1);
	assert.equal(received[0]?.observation.epoch, "epoch_2");

	// Trigger realtime with stale older epoch
	mockSdk.triggerRealtime(1);
	await new Promise((r) => setTimeout(r, 30));

	// Should NOT accept older epoch snapshot
	assert.equal(received.length, 1);

	unsubscribe();
});
