import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "../setup-dom.ts";
import type { RuntimeGraphSnapshot } from "../../src/runtime-graph/types.ts";
import {
	subscribeRuntimeGraph,
	type RuntimeGraphRealtimeClient,
} from "../../src/ui/runtime-graph/subscription.ts";
import { getOrCreateRuntimeGraphStore } from "../../src/ui/runtime-graph/store.ts";

setupDom();

function makeSnapshot(epoch: string, revision: number, liveCount = 1): RuntimeGraphSnapshot {
	return {
		version: 1,
		scope: { sessionId: "sess-1", rootConversationId: "1", buildId: "b-1" },
		observation: { epoch, revision, observedAt: 1000 + revision, completeness: "complete" },
		nodes: liveCount > 0
			? { "1": { id: 1, kind: "pi.tool", conversationId: 1, background: false, abortRequested: false, state: { status: "running" }, label: "task" } }
			: {},
		conversations: { "1": { id: 1 } },
		receipts: liveCount === 0
			? [{ taskId: 1, conversationId: 1, kind: "pi.tool", outcome: "completed", endedAt: 2000, durationMs: 1000 }]
			: [],
		stats: { liveCount, terminalCount: liveCount === 0 ? 1 : 0, totalCount: 1 },
	};
}

describe("Runtime Graph Subscription Parity (Phase 4 Transport Remediation)", () => {
	test("realistic SDK with root subscribe updates store on background worker completion", async () => {
		let currentRev = 1;
		let listCalls = 0;
		let subscribeCalls = 0;
		let unsubscribeCalls = 0;
		let threadChangedCallback: ((event: unknown) => void) | undefined;

		const realisticSdk: RuntimeGraphRealtimeClient = {
			threads: {
				events: {
					list: async () => {
						listCalls++;
						const snap = makeSnapshot("epoch-1", currentRev, currentRev === 1 ? 1 : 0);
						return [{ type: "thread/extensionState/updated", kind: "provider-pi-durable/runtime-graph", payload: snap, seq: currentRev }];
					},
				},
			},
			subscribe: (args: any) => {
				subscribeCalls++;
				if (args.event === "thread:changed") threadChangedCallback = args.callback;
				return () => { unsubscribeCalls++; };
			},
		} as any;

		assert.equal("realtime" in realisticSdk, false, "realisticSdk must NOT have realtime property");

		const store = getOrCreateRuntimeGraphStore(realisticSdk, "thr-test-realtime-parity");
		const unsubStore = store.subscribe(() => {});

		// 1. Initial mount fetch
		await new Promise((r) => setTimeout(r, 60));
		assert.equal(listCalls, 1, "Initial fetch must execute once on mount");
		assert.equal(subscribeCalls, 1, "Root sdk.subscribe must be called on mount");
		assert.equal(store.getState().snapshot?.observation.revision, 1);
		assert.equal(store.getState().snapshot?.stats.liveCount, 1);

		// 2. Background worker completes: rev advances to 2, Core emits thread:changed
		currentRev = 2;
		assert.ok(threadChangedCallback, "thread:changed callback must have been registered via root sdk.subscribe");
		threadChangedCallback({ event: "thread:changed", threadId: "thr-test-realtime-parity" });

		await new Promise((r) => setTimeout(r, 160));
		assert.ok(listCalls >= 2, "Second fetch must be triggered by thread:changed event");
		assert.equal(store.getState().snapshot?.observation.revision, 2, "Store snapshot MUST advance to revision 2!");
		assert.equal(store.getState().snapshot?.stats.liveCount, 0, "Store snapshot MUST reflect completed task!");

		// 3. Refcount cleanup and disposal
		unsubStore();
		await new Promise((r) => setTimeout(r, 80));
		assert.ok(unsubscribeCalls >= 1, "Root sdk.subscribe unsubscribe MUST be called on store disposal");
	});

	test("missing root subscribe reports unavailable status rather than frozen green snapshot", async () => {
		const statuses: string[] = [];
		const invalidSdk: any = {
			threads: {
				events: {
					list: async () => [{
						type: "thread/extensionState/updated",
						kind: "provider-pi-durable/runtime-graph",
						payload: makeSnapshot("epoch-1", 1),
						seq: 1,
					}],
				},
			},
		};

		const unsub = subscribeRuntimeGraph(invalidSdk, {
			threadId: "thr-no-subscribe",
			onSnapshot: () => {},
			onStatusChange: (status) => statuses.push(status),
		});

		await new Promise((r) => setTimeout(r, 50));
		assert.ok(statuses.includes("unavailable"), `Missing subscribe contract must report "unavailable"`);
		unsub();
	});

	test("in-flight burst follow-up: coalesces multiple events and updates to latest revision", async () => {
		let currentRev = 1;
		let listCalls = 0;
		let callback: ((event: unknown) => void) | undefined;

		const sdk: any = {
			threads: {
				events: {
					list: async () => {
						listCalls++;
						return [{
							type: "thread/extensionState/updated",
							kind: "provider-pi-durable/runtime-graph",
							payload: makeSnapshot("epoch-1", currentRev),
							seq: currentRev,
						}];
					},
				},
			},
			subscribe: (args: any) => {
				callback = args.callback;
				return () => {};
			},
		};

		const snapshots: RuntimeGraphSnapshot[] = [];
		const unsub = subscribeRuntimeGraph(sdk, {
			threadId: "thr-burst",
			debounceMs: 30,
			onSnapshot: (s) => snapshots.push(s),
		});

		await new Promise((r) => setTimeout(r, 50));
		assert.equal(snapshots.length, 1);

		currentRev = 5;
		for (let i = 0; i < 5; i++) callback?.({ event: "thread:changed", threadId: "thr-burst" });

		await new Promise((r) => setTimeout(r, 80));
		assert.equal(snapshots[snapshots.length - 1]?.observation.revision, 5);
		assert.equal(listCalls, 2, "Burst should coalesce to 1 additional fetch");
		unsub();
	});
});
