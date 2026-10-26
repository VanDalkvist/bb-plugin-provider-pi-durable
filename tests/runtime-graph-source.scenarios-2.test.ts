import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeGraphSource } from "../src/runner/runtime-graph-source.ts";
import type { TaskGraph } from "@earendil-works/pi-durable";
import type { RuntimeGraphSnapshot } from "../src/runtime-graph/types.ts";

function createMockViewSource(initialGraph: TaskGraph) {
	let currentGraph = initialGraph;
	const listeners = new Set<() => void>();
	return {
		current: () => currentGraph,
		update: (next: TaskGraph) => { currentGraph = next; for (const l of listeners) l(); },
		subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
	};
}

test("runtime-graph-source: owner chain is preserved after owner task completes", async () => {
	const initialGraph: TaskGraph = {
		tasks: {
			"10": {
				id: 10 as any,
				kind: "pi.subagent",
				conversationId: 1 as any,
				background: false,
				abortRequested: false,
				state: { status: "running" },
				conversations: [2 as any],
			},
		},
	};

	const viewSource = createMockViewSource(initialGraph);
	const snapshots: RuntimeGraphSnapshot[] = [];
	const source = new RuntimeGraphSource(
		viewSource,
		{ sessionId: "sess_1", rootConversationId: "1", buildId: "b1" },
		{ debounceMs: 20 },
	);

	source.subscribe((s) => snapshots.push(s));
	await new Promise((r) => setTimeout(r, 40));

	assert.equal(snapshots.length, 1);
	assert.deepEqual(snapshots[0]?.conversations["2"]?.owner, {
		conversationId: 1,
		taskId: 10,
	});

	viewSource.update({ tasks: {} });
	await new Promise((r) => setTimeout(r, 40));

	assert.equal(snapshots.length, 2);
	assert.ok(snapshots[1]?.conversations["2"], "Conversation 2 must still exist in snapshot");
	assert.deepEqual(
		snapshots[1]?.conversations["2"]?.owner,
		{ conversationId: 1, taskId: 10 },
		"Owner link must not be lost after owner task completes",
	);

	source.teardown();
});

test("runtime-graph-source: disappearance without receipt marks completeness limited without inventing orphaned outcome", async () => {
	const initialGraph: TaskGraph = {
		tasks: {
			"50": {
				id: 50 as any,
				kind: "pi.tool",
				conversationId: 1 as any,
				background: false,
				abortRequested: false,
				state: { status: "running" },
				conversations: [],
			},
		},
	};

	const viewSource = createMockViewSource(initialGraph);
	const snapshots: RuntimeGraphSnapshot[] = [];
	const source = new RuntimeGraphSource(
		viewSource,
		{ sessionId: "sess_1", rootConversationId: "1", buildId: "b1" },
		{ debounceMs: 20 },
	);

	source.subscribe((s) => snapshots.push(s));
	await new Promise((r) => setTimeout(r, 40));

	assert.equal(snapshots.length, 1);
	assert.equal(snapshots[0]?.observation.completeness, "complete");

	viewSource.update({ tasks: {} });
	await new Promise((r) => setTimeout(r, 40));

	assert.equal(snapshots.length, 2);
	assert.equal(snapshots[1]?.observation.completeness, "limited");
	const fakeOrphaned = snapshots[1]?.receipts.find((r) => r.taskId === 50 && r.outcome === "orphaned");
	assert.equal(fakeOrphaned, undefined, "Must NEVER invent an orphaned receipt on disappearance");

	source.teardown();
});

test("runtime-graph-source: harness commits record authoritative terminal task receipts and conversation records", async () => {
	const initialGraph: TaskGraph = {
		tasks: {
			"40": {
				id: 40 as any,
				kind: "pi.tool",
				conversationId: 1 as any,
				background: false,
				abortRequested: false,
				state: { status: "running" },
				conversations: [],
			},
		},
	};

	const viewSource = createMockViewSource(initialGraph);
	const snapshots: RuntimeGraphSnapshot[] = [];
	let commitListener: ((pub: { changes: readonly any[] }) => void) | undefined;

	const mockHarness = {
		subscribeCommits: (listener: (pub: { changes: readonly any[] }) => void) => {
			commitListener = listener;
			return () => { commitListener = undefined; };
		},
		getTask: async (_id: any) => undefined,
	};

	const source = new RuntimeGraphSource(
		viewSource,
		{ sessionId: "sess_1", rootConversationId: "1", buildId: "b1" },
		{ debounceMs: 20, harness: mockHarness },
	);

	source.subscribe((s) => snapshots.push(s));
	await new Promise((r) => setTimeout(r, 40));

	assert.equal(snapshots.length, 1);
	assert.equal(snapshots[0]?.nodes["40"]?.id, 40);

	commitListener?.({
		changes: [
			{
				type: "task",
				value: {
					id: 40,
					conversationId: 1,
					kind: "pi.tool",
					version: 1,
					endedAt: 2000,
					startedAt: 1000,
					state: {
						status: "terminal",
						outcome: { status: "completed", result: { output: "done" } },
					},
				},
			},
			{
				type: "conversation",
				value: {
					id: 5,
					owner: { conversationId: 1, taskId: 40 },
				},
			},
		],
	});

	viewSource.update({ tasks: {} });
	await new Promise((r) => setTimeout(r, 40));

	const latest = snapshots[snapshots.length - 1];
	assert.ok(latest);
	assert.equal(latest.nodes["40"], undefined, "Task 40 is no longer live");
	assert.equal(latest.receipts.length, 1);
	assert.equal(latest.receipts[0]?.taskId, 40);
	assert.equal(latest.receipts[0]?.outcome, "completed");
	assert.equal(latest.receipts[0]?.durationMs, 1000);
	assert.equal(latest.observation.completeness, "complete");
	assert.deepEqual(latest.conversations["5"]?.owner, { conversationId: 1, taskId: 40 });

	source.teardown();
});
