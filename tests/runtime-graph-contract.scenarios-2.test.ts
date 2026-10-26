import test from "node:test";
import assert from "node:assert/strict";
import {
	runtimeGraphSnapshotSchema,
	runtimeTaskNodeSchema,
	runtimeTaskReceiptSchema,
} from "../src/runtime-graph/schema.ts";

test("runtime-graph-contract: rejects future/terminal state in live node", () => {
	const invalidLiveNode = {
		id: 20,
		kind: "pi.tool",
		conversationId: 1,
		background: false,
		abortRequested: false,
		state: {
			status: "terminal", // terminal belongs in receipts, not live state!
			outcome: "completed",
		},
		label: "terminal task",
	};

	const parsed = runtimeTaskNodeSchema.safeParse(invalidLiveNode);
	assert.equal(parsed.success, false);
});

test("runtime-graph-contract: rejects non-numeric or non-positive IDs", () => {
	const badIdNode = {
		id: -5,
		kind: "pi.tool",
		conversationId: 1,
		background: false,
		abortRequested: false,
		state: { status: "pending" },
		label: "bad id task",
	};

	const parsed = runtimeTaskNodeSchema.safeParse(badIdNode);
	assert.equal(parsed.success, false);
});

test("runtime-graph-contract: rejects oversized labels and preview strings", () => {
	const oversizedLabel = "x".repeat(161);
	const node = {
		id: 1,
		kind: "pi.tool",
		conversationId: 1,
		background: false,
		abortRequested: false,
		state: { status: "pending" },
		label: oversizedLabel,
	};
	const parsedNode = runtimeTaskNodeSchema.safeParse(node);
	assert.equal(parsedNode.success, false);

	const oversizedPreview = "y".repeat(501);
	const receipt = {
		taskId: 1,
		conversationId: 1,
		kind: "pi.tool",
		outcome: "failed",
		endedAt: 1000,
		preview: oversizedPreview,
	};
	const parsedReceipt = runtimeTaskReceiptSchema.safeParse(receipt);
	assert.equal(parsedReceipt.success, false);
});

test("runtime-graph-contract: rejects snapshot exceeding maximum live nodes or receipts", () => {
	const excessNodes: Record<string, unknown> = {};
	for (let i = 1; i <= 513; i++) {
		excessNodes[String(i)] = {
			id: i,
			kind: "pi.tool",
			conversationId: 1,
			background: false,
			abortRequested: false,
			state: { status: "pending" },
			label: `task ${i}`,
		};
	}

	const snapshot = {
		version: 1,
		scope: { sessionId: "s1", rootConversationId: "1", buildId: "b1" },
		observation: { epoch: "e1", revision: 1, observedAt: 100, completeness: "complete" },
		nodes: excessNodes,
		conversations: { "1": { id: 1 } },
		receipts: [],
		stats: { liveCount: 513, terminalCount: 0, totalCount: 513 },
	};

	const parsed = runtimeGraphSnapshotSchema.safeParse(snapshot);
	assert.equal(parsed.success, false);
});
