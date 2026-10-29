import test from "node:test";
import assert from "node:assert/strict";
import type { RuntimeGraphSnapshot } from "../../src/runtime-graph/types.ts";
import { buildTaskTree } from "../../src/ui/runtime-graph/tree-builder.ts";

function createMockSnapshot(overrides?: Partial<RuntimeGraphSnapshot>): RuntimeGraphSnapshot {
	return {
		version: 1,
		scope: { sessionId: "session-1", rootConversationId: "1", buildId: "build-1" },
		observation: { epoch: "epoch-1", revision: 1, observedAt: 1000, completeness: "complete" },
		nodes: {},
		conversations: { "1": { id: 1 } },
		receipts: [],
		stats: { liveCount: 0, terminalCount: 0, totalCount: 0 },
		...overrides,
	};
}

test("buildTaskTree: empty snapshot produces empty tree", () => {
	const snapshot = createMockSnapshot();
	const tree = buildTaskTree(snapshot);
	assert.deepEqual(tree, []);
});

test("buildTaskTree: builds hierarchy strictly along task owner", () => {
	const snapshot = createMockSnapshot({
		nodes: {
			"10": {
				id: 10, kind: "pi.generation", conversationId: 1,
				background: false, abortRequested: false,
				state: { status: "running", phase: "generating" }, label: "Root Generation",
			},
			"11": {
				id: 11, kind: "bash", conversationId: 1, owner: 10,
				background: false, abortRequested: false,
				state: { status: "running", phase: "executing" }, label: "bash: npm test",
			},
			"12": {
				id: 12, kind: "read", conversationId: 1, owner: 10,
				background: false, abortRequested: false,
				state: { status: "completed" as any, phase: "done" }, label: "read: package.json",
			},
		},
	});

	const tree = buildTaskTree(snapshot);
	assert.equal(tree.length, 1);
	assert.equal(tree[0].id, 10);
	assert.equal(tree[0].children.length, 2);
	assert.equal(tree[0].children[0].id, 11);
	assert.equal(tree[0].children[1].id, 12);
});

test("buildTaskTree: wait edge does NOT create a parent node", () => {
	const snapshot = createMockSnapshot({
		nodes: {
			"10": {
				id: 10, kind: "pi.generation", conversationId: 1,
				background: false, abortRequested: false,
				state: { status: "running", phase: "generating" }, label: "Task 10",
			},
			"11": {
				id: 11, kind: "bash", conversationId: 1,
				background: false, abortRequested: false,
				state: { status: "waiting", phase: "waiting_deps", on: [10], policy: "allSettled" },
				label: "Task 11 waiting on 10",
			},
		},
	});

	const tree = buildTaskTree(snapshot);
	assert.equal(tree.length, 2, "Task 11 must NOT become child of task 10");
	assert.equal(tree[0].id, 10);
	assert.equal(tree[1].id, 11);
	assert.deepEqual(tree[1].waitingOn, [10]);
});

test("buildTaskTree: computes tokenDelta chronologically per conversation", () => {
	const snapshot = createMockSnapshot({
		receipts: [
			{ taskId: 1, conversationId: 1, kind: "pi.generation", outcome: "completed", endedAt: 1000, durationMs: 500, tokens: { total: 155000 } },
			{ taskId: 2, conversationId: 1, kind: "pi.generation", outcome: "completed", endedAt: 2000, durationMs: 600, tokens: { total: 156500 } },
			{ taskId: 3, conversationId: 1, kind: "pi.generation", outcome: "completed", endedAt: 3000, durationMs: 700, tokens: { total: 172000 } },
		],
	});

	const tree = buildTaskTree(snapshot);
	assert.equal(tree.length, 3);
	// Sorted by id: task 1 (first), task 2 (second), task 3 (third)
	const t1 = tree.find((t) => t.id === 1)!;
	const t2 = tree.find((t) => t.id === 2)!;
	const t3 = tree.find((t) => t.id === 3)!;

	assert.equal(t1.tokenDelta, 155000, "First generation gets its full token count as delta");
	assert.equal(t2.tokenDelta, 1500, "Second generation gets 156500 - 155000 = 1500");
	assert.equal(t3.tokenDelta, 15500, "Third generation gets 172000 - 156500 = 15500");
});

