import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "../setup-dom.ts";
import type { RuntimeGraphSnapshot } from "../../src/runtime-graph/types.ts";
import { subscribeRuntimeGraph, type RuntimeGraphRealtimeClient } from "../../src/ui/runtime-graph/subscription.ts";

setupDom();

function makeSnapshot(epoch: string, revision: number): RuntimeGraphSnapshot {
	return {
		version: 1,
		scope: { sessionId: "s1", rootConversationId: "1", buildId: "b1" },
		observation: { epoch, revision, observedAt: 1000 + revision, completeness: "complete" },
		nodes: {},
		conversations: { "1": { id: 1 } },
		receipts: [{ taskId: 1, conversationId: 1, kind: "pi.tool", outcome: "completed", endedAt: 2000, durationMs: 1000 }],
		stats: { liveCount: 0, terminalCount: 1, totalCount: 1 },
	};
}

describe("Transport Review Remediation (TR1, TR2, TR3)", () => {
	test("TR1: duplicate or stale revision restores status to 'ok' and never leaves stuck in 'loading'", async () => {
		let currentRev = 1;
		let callback: ((event: unknown) => void) | undefined;
		const statuses: string[] = [];

		const sdk: RuntimeGraphRealtimeClient = {
			threads: {
				events: {
					list: async () => [{
						type: "thread/extensionState/updated", kind: "provider-pi-durable/runtime-graph",
						payload: makeSnapshot("epoch-1", currentRev), seq: currentRev,
					}],
				},
			},
			subscribe: (args: any) => {
				if (args.event === "thread:changed") callback = args.callback;
				return () => {};
			},
		};

		const unsub = subscribeRuntimeGraph(sdk, {
			threadId: "thr-tr1", debounceMs: 15,
			onSnapshot: () => {}, onStatusChange: (s) => statuses.push(s),
		});

		await new Promise((r) => setTimeout(r, 40));
		assert.equal(statuses[statuses.length - 1], "ok", "Initial fetch must end in 'ok'");

		callback?.({ event: "thread:changed", threadId: "thr-tr1" });
		await new Promise((r) => setTimeout(r, 50));

		assert.equal(statuses[statuses.length - 1], "ok", "Duplicate revision MUST restore status to 'ok'");
		assert.notEqual(statuses[statuses.length - 1], "loading", "Must NOT remain stuck in 'loading'");
		unsub();
	});

	test("TR2: continuous streaming faster than debounceMs guarantees bounded refresh via maxDebounceMs", async () => {
		let listCalls = 0;
		let callback: ((event: unknown) => void) | undefined;

		const sdk: RuntimeGraphRealtimeClient = {
			threads: {
				events: {
					list: async () => {
						listCalls++;
						return [{
							type: "thread/extensionState/updated", kind: "provider-pi-durable/runtime-graph",
							payload: makeSnapshot("epoch-1", listCalls), seq: listCalls,
						}];
					},
				},
			},
			subscribe: (args: any) => {
				if (args.event === "thread:changed") callback = args.callback;
				return () => {};
			},
		};

		const unsub = subscribeRuntimeGraph(sdk, {
			threadId: "thr-tr2", debounceMs: 50, maxDebounceMs: 120, onSnapshot: () => {},
		});

		await new Promise((r) => setTimeout(r, 30));
		const initialCalls = listCalls;
		assert.equal(initialCalls, 1, "Initial fetch completes on mount");

		const interval = setInterval(() => {
			callback?.({ event: "thread:changed", threadId: "thr-tr2" });
		}, 20);

		await new Promise((r) => setTimeout(r, 300));
		clearInterval(interval);

		const callsDuringStream = listCalls - initialCalls;
		assert.ok(callsDuringStream >= 2, `Stream must NOT starve; observed ${callsDuringStream} refreshes`);

		await new Promise((r) => setTimeout(r, 80));
		assert.ok(listCalls - initialCalls >= callsDuringStream + 1, "Trailing fetch must fire after stream ends");
		unsub();
	});

	test("TR3: slow overlapping fetches serialize to at most 1 in-flight with 1 coalesced follow-up", async () => {
		let listCalls = 0, activeFetches = 0, maxConcurrent = 0;
		let callback: ((event: unknown) => void) | undefined;

		const sdk: RuntimeGraphRealtimeClient = {
			threads: {
				events: {
					list: async () => {
						listCalls++;
						activeFetches++;
						if (activeFetches > maxConcurrent) maxConcurrent = activeFetches;
						await new Promise((r) => setTimeout(r, 60));
						activeFetches--;
						return [{
							type: "thread/extensionState/updated", kind: "provider-pi-durable/runtime-graph",
							payload: makeSnapshot("epoch-1", listCalls), seq: listCalls,
						}];
					},
				},
			},
			subscribe: (args: any) => {
				if (args.event === "thread:changed") callback = args.callback;
				return () => {};
			},
		};

		const unsub = subscribeRuntimeGraph(sdk, {
			threadId: "thr-tr3", debounceMs: 20, onSnapshot: () => {},
		});

		await new Promise((r) => setTimeout(r, 25));
		callback?.({ event: "thread:changed", threadId: "thr-tr3" });
		await new Promise((r) => setTimeout(r, 15));
		callback?.({ event: "thread:changed", threadId: "thr-tr3" });

		await new Promise((r) => setTimeout(r, 160));
		assert.equal(maxConcurrent, 1, "Max concurrent in-flight fetches must strictly be 1");
		assert.equal(listCalls, 2, "Events arriving during in-flight fetch must coalesce into exactly 1 follow-up");
		unsub();
	});

	test("honest error guard: read failure or network reject reports 'unavailable', not masked cached 'ok'", async () => {
		let shouldFail = false;
		let callback: ((event: unknown) => void) | undefined;
		const statuses: string[] = [];
		const receivedSnapshots: RuntimeGraphSnapshot[] = [];

		const sdk: RuntimeGraphRealtimeClient = {
			threads: {
				events: {
					list: async () => {
						if (shouldFail) throw new Error("Simulated network/DB connection failure");
						return [{
							type: "thread/extensionState/updated", kind: "provider-pi-durable/runtime-graph",
							payload: makeSnapshot("epoch-1", 1), seq: 1,
						}];
					},
				},
			},
			subscribe: (args: any) => {
				if (args.event === "thread:changed") callback = args.callback;
				return () => {};
			},
		};

		const unsub = subscribeRuntimeGraph(sdk, {
			threadId: "thr-error-guard", debounceMs: 15,
			onSnapshot: (s) => receivedSnapshots.push(s), onStatusChange: (s) => statuses.push(s),
		});

		await new Promise((r) => setTimeout(r, 40));
		assert.equal(statuses[statuses.length - 1], "ok");
		assert.equal(receivedSnapshots.length, 1);

		shouldFail = true;
		callback?.({ event: "thread:changed", threadId: "thr-error-guard" });
		await new Promise((r) => setTimeout(r, 50));

		assert.equal(statuses[statuses.length - 1], "unavailable", "Real network/read failure MUST report 'unavailable'");
		assert.equal(receivedSnapshots.length, 1, "Cached snapshot must not be deleted");
		unsub();
	});
});
