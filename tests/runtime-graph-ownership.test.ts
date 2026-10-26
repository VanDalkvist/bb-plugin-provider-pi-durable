import test from "node:test";
import assert from "node:assert/strict";
import {
	isConversationInScope,
	filterSnapshotForConversation,
} from "../src/runner/runtime-graph-scope.ts";
import type { RuntimeGraphSnapshot } from "../src/runtime-graph/types.ts";

test("runtime-graph-ownership: root conversation scope includes all root-owned conversations", () => {
	const conversations = new Map([
		[1, { id: 1 }],
		[2, { id: 2, owner: { conversationId: 1, taskId: 10 } }],
		[3, { id: 3, owner: { conversationId: 2, taskId: 20 } }],
	]);

	assert.equal(isConversationInScope(1, 1, conversations), true);
	assert.equal(isConversationInScope(2, 1, conversations), true);
	assert.equal(isConversationInScope(3, 1, conversations), true);
});

test("runtime-graph-ownership: child conversation scope includes self and owned descendants, NOT parent or unrelated", () => {
	const conversations = new Map([
		[1, { id: 1 }],
		[2, { id: 2, owner: { conversationId: 1, taskId: 10 } }],
		[3, { id: 3, owner: { conversationId: 2, taskId: 20 } }],
		[4, { id: 4, owner: { conversationId: 1, taskId: 30 } }], // sibling child
		[5, { id: 5 }], // ownerless conversation
	]);

	// Child 2's perspective:
	assert.equal(isConversationInScope(1, 2, conversations), false); // root parent is NOT in child scope
	assert.equal(isConversationInScope(2, 2, conversations), true); // self is in scope
	assert.equal(isConversationInScope(3, 2, conversations), true); // owned grandchild is in scope
	assert.equal(isConversationInScope(4, 2, conversations), false); // sibling child 4 does NOT leak in
	assert.equal(isConversationInScope(5, 2, conversations), false); // ownerless 5 does NOT leak in
});

test("runtime-graph-ownership: fork parent is NOT creator ownership", () => {
	const conversations = new Map([
		[1, { id: 1 }],
		// Conversation 2 was forked from 1, but has NO owner (e.g. standalone fork)
		[2, { id: 2, parent: { conversationId: 1, at: 50 } }],
		// Conversation 3 has owner 2, and fork parent 1
		[3, { id: 3, owner: { conversationId: 2, taskId: 15 }, parent: { conversationId: 1, at: 60 } }],
	]);

	// Child 3's scope must NOT inherit from fork parent 1
	assert.equal(isConversationInScope(1, 3, conversations), false);
	assert.equal(isConversationInScope(2, 3, conversations), false);
	assert.equal(isConversationInScope(3, 3, conversations), true);
});

test("runtime-graph-ownership: terminal owner retains conversation ownership", () => {
	// Even after task 10 is terminal, conversation 2 still records owner: { conversationId: 1, taskId: 10 }
	const conversations = new Map([
		[1, { id: 1 }],
		[2, { id: 2, owner: { conversationId: 1, taskId: 10 } }],
	]);

	assert.equal(isConversationInScope(2, 1, conversations), true);
	assert.equal(isConversationInScope(2, 2, conversations), true);
});

test("runtime-graph-ownership: filterSnapshotForConversation isolates nodes, conversations, and receipts", () => {
	const snapshot: RuntimeGraphSnapshot = {
		version: 1,
		scope: { sessionId: "sess_1", rootConversationId: "1", buildId: "b1" },
		observation: { epoch: "e1", revision: 1, observedAt: 1000, completeness: "complete" },
		nodes: {
			"10": {
				id: 10,
				kind: "pi.tool",
				conversationId: 1,
				background: false,
				abortRequested: false,
				state: { status: "running" },
				label: "root tool",
			},
			"20": {
				id: 20,
				kind: "pi.tool",
				conversationId: 2,
				background: false,
				abortRequested: false,
				state: { status: "running" },
				label: "child tool",
			},
		},
		conversations: {
			"1": { id: 1 },
			"2": { id: 2, owner: { conversationId: 1, taskId: 10 } },
		},
		receipts: [
			{ taskId: 5, conversationId: 1, kind: "pi.tool", outcome: "completed", endedAt: 500 },
			{ taskId: 15, conversationId: 2, kind: "pi.tool", outcome: "failed", endedAt: 600 },
		],
		stats: { liveCount: 2, terminalCount: 2, totalCount: 4 },
	};

	const filtered = filterSnapshotForConversation(snapshot, 2);

	// In child 2's snapshot:
	assert.deepEqual(Object.keys(filtered.nodes), ["20"]);
	assert.equal(filtered.nodes["20"]?.label, "child tool");
	assert.deepEqual(Object.keys(filtered.conversations), ["2"]);
	assert.equal(filtered.receipts.length, 1);
	assert.equal(filtered.receipts[0]?.taskId, 15);
	assert.equal(filtered.stats.liveCount, 1);
	assert.equal(filtered.stats.terminalCount, 1);
	assert.equal(filtered.stats.totalCount, 2);
});
