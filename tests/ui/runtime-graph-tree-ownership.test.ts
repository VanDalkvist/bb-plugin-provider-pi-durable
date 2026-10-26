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

test("buildTaskTree: conversation ownership nests subagent conversation tasks under creator task", () => {
	const snapshot = createMockSnapshot({
		conversations: {
			"1": { id: 1 },
			"2": { id: 2, owner: { conversationId: 1, taskId: 10 } },
		},
		nodes: {
			"10": {
				id: 10, kind: "subagent", conversationId: 1,
				background: true, abortRequested: false,
				state: { status: "running", phase: "delegating" }, label: "subagent: reviewer",
			},
			"20": {
				id: 20, kind: "pi.generation", conversationId: 2,
				background: false, abortRequested: false,
				state: { status: "running", phase: "thinking" }, label: "Child Subagent Generation",
			},
			"21": {
				id: 21, kind: "bash", conversationId: 2, owner: 20,
				background: false, abortRequested: false,
				state: { status: "running", phase: "executing" }, label: "bash: git status",
			},
		},
	});

	const tree = buildTaskTree(snapshot);
	assert.equal(tree.length, 1);
	assert.equal(tree[0].id, 10);
	assert.equal(tree[0].children.length, 1);
	assert.equal(tree[0].children[0].id, 20);
	assert.equal(tree[0].children[0].children.length, 1);
	assert.equal(tree[0].children[0].children[0].id, 21);
});

test("buildTaskTree: fork parent is NOT ownership (remains separate root)", () => {
	const snapshot = createMockSnapshot({
		conversations: {
			"1": { id: 1 },
			"3": { id: 3, parent: { conversationId: 1, at: 500 } },
		},
		nodes: {
			"10": {
				id: 10, kind: "pi.generation", conversationId: 1,
				background: false, abortRequested: false,
				state: { status: "running", phase: "generating" }, label: "Root Task",
			},
			"30": {
				id: 30, kind: "pi.generation", conversationId: 3,
				background: false, abortRequested: false,
				state: { status: "running", phase: "forked_gen" }, label: "Forked Task",
			},
		},
	});

	const tree = buildTaskTree(snapshot);
	assert.equal(tree.length, 2, "Forked task must NOT become child of task 10");
	assert.equal(tree[0].id, 10);
	assert.equal(tree[1].id, 30);
});

test("buildTaskTree: merges live nodes and recent receipts cleanly", () => {
	const snapshot = createMockSnapshot({
		nodes: {
			"10": {
				id: 10, kind: "pi.generation", conversationId: 1,
				background: false, abortRequested: false,
				state: { status: "completing", outcome: "completed" }, label: "Completing Generation",
			},
		},
		receipts: [
			{ taskId: 10, conversationId: 1, kind: "pi.generation", outcome: "completed", endedAt: 2000, durationMs: 1000 },
			{ taskId: 9, conversationId: 1, kind: "read", outcome: "completed", endedAt: 950, durationMs: 50, preview: "read file" },
		],
	});

	const tree = buildTaskTree(snapshot);
	assert.equal(tree.length, 2);
	assert.equal(tree[0].id, 9);
	assert.equal(tree[0].isTerminal, true);
	assert.equal(tree[1].id, 10);
	assert.equal(tree[1].liveNode?.state.status, "completing");
});

test("buildTaskTree: terminal owner chains are preserved", () => {
	const snapshot = createMockSnapshot({
		conversations: {
			"1": { id: 1 },
			"2": { id: 2, owner: { conversationId: 1, taskId: 5 } },
		},
		receipts: [
			{ taskId: 5, conversationId: 1, kind: "subagent", outcome: "completed", endedAt: 1500, durationMs: 500 },
		],
		nodes: {
			"20": {
				id: 20, kind: "bash", conversationId: 2,
				background: false, abortRequested: false,
				state: { status: "running", phase: "working" }, label: "Child task in conversation 2",
			},
		},
	});

	const tree = buildTaskTree(snapshot);
	assert.equal(tree.length, 1);
	assert.equal(tree[0].id, 5);
	assert.equal(tree[0].children.length, 1);
	assert.equal(tree[0].children[0].id, 20);
});
