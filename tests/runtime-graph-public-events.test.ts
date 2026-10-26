import test from "node:test";
import assert from "node:assert/strict";
import { readRuntimeGraphSnapshot } from "../src/ui/runtime-graph/read.ts";
import type { RuntimeGraphSnapshot } from "../src/runtime-graph/types.ts";

function createMockSdk(pages: any[][]) {
	let callCount = 0;
	return {
		threads: {
			events: {
				list: async (args: any) => {
					const pageIndex = callCount++;
					const items = pages[pageIndex] ?? [];
					return items;
				},
			},
		},
	};
}

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

test("runtime-graph-public-events: reads latest snapshot from thread/extensionState/updated", async () => {
	const snapshotV1 = makeSnapshot("epoch_1", 1);
	const snapshotV2 = makeSnapshot("epoch_1", 2);

	const mockSdk = createMockSdk([
		[
			{
				type: "thread/extensionState/updated",
				kind: "provider-pi-durable/runtime-graph",
				payload: snapshotV2,
				threadId: "thr_1",
				providerThreadId: "p1",
				seq: 20,
			},
			{
				type: "thread/extensionState/updated",
				kind: "other-plugin/state", // foreign kind, must be ignored
				payload: { something: true },
				threadId: "thr_1",
				seq: 15,
			},
			{
				type: "thread/extensionState/updated",
				kind: "provider-pi-durable/runtime-graph",
				payload: snapshotV1,
				threadId: "thr_1",
				seq: 10,
			},
		],
	]);

	const result = await readRuntimeGraphSnapshot(mockSdk as any, "thr_1");
	assert.equal(result.status, "ok");
	if (result.status === "ok") {
		assert.equal(result.snapshot.observation.revision, 2);
	}
});

test("runtime-graph-public-events: pages through events using beforeSeq up to 5 pages", async () => {
	const snapshot = makeSnapshot("epoch_1", 5);

	// Page 0 has unrelated events, Page 1 has our event
	const mockSdk = createMockSdk([
		[
			{ type: "thread/tokenUsage/updated", threadId: "thr_1", seq: 50 },
			{ type: "turn/completed", threadId: "thr_1", seq: 49 },
		],
		[
			{
				type: "thread/extensionState/updated",
				kind: "provider-pi-durable/runtime-graph",
				payload: snapshot,
				threadId: "thr_1",
				seq: 30,
			},
		],
	]);

	const result = await readRuntimeGraphSnapshot(mockSdk as any, "thr_1");
	assert.equal(result.status, "ok");
	if (result.status === "ok") {
		assert.equal(result.snapshot.observation.revision, 5);
	}
});

test("runtime-graph-public-events: returns unavailable when no matching events found after page limit", async () => {
	// 5 empty pages
	const mockSdk = createMockSdk([[], [], [], [], []]);

	const result = await readRuntimeGraphSnapshot(mockSdk as any, "thr_1");
	assert.equal(result.status, "unavailable");
});

test("runtime-graph-public-events: filters by child conversation if specified", async () => {
	const rootSnapshot = makeSnapshot("epoch_1", 1);
	(rootSnapshot as any).nodes = {
		"1": {
			id: 1,
			kind: "pi.tool",
			conversationId: 1,
			background: false,
			abortRequested: false,
			state: { status: "running" },
			label: "root tool",
		},
		"2": {
			id: 2,
			kind: "pi.tool",
			conversationId: 2,
			background: false,
			abortRequested: false,
			state: { status: "running" },
			label: "child tool",
		},
	};
	(rootSnapshot as any).conversations = {
		"1": { id: 1 },
		"2": { id: 2, owner: { conversationId: 1, taskId: 1 } },
	};
	(rootSnapshot as any).stats = { liveCount: 2, terminalCount: 0, totalCount: 2 };

	const mockSdk = createMockSdk([
		[
			{
				type: "thread/extensionState/updated",
				kind: "provider-pi-durable/runtime-graph",
				payload: rootSnapshot,
				threadId: "thr_1",
				seq: 10,
			},
		],
	]);

	const result = await readRuntimeGraphSnapshot(mockSdk as any, "thr_1", { conversationId: 2 });
	assert.equal(result.status, "ok");
	if (result.status === "ok") {
		// Only child 2 node should remain
		assert.deepEqual(Object.keys(result.snapshot.nodes), ["2"]);
	}
});
