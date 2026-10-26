import test from "node:test";
import assert from "node:assert/strict";
import {
	runtimeGraphSnapshotSchema,
	runtimeTaskNodeSchema,
	runtimeTaskReceiptSchema,
} from "../src/runtime-graph/schema.ts";
import type { RuntimeGraphSnapshot } from "../src/runtime-graph/types.ts";

test("runtime-graph-contract: validates valid runtime graph snapshot", () => {
	const validSnapshot: RuntimeGraphSnapshot = {
		version: 1,
		scope: {
			sessionId: "sess_123",
			rootConversationId: "1",
			buildId: "build_abc",
		},
		observation: {
			epoch: "epoch_1",
			revision: 42,
			observedAt: Date.now(),
			completeness: "complete",
		},
		nodes: {
			"10": {
				id: 10,
				kind: "pi.tool",
				conversationId: 1,
				owner: 5,
				background: false,
				abortRequested: false,
				state: {
					status: "running",
					phase: "execute",
				},
				label: "executing bash command",
				startedAt: 1000,
			},
		},
		conversations: {
			"1": {
				id: 1,
			},
			"2": {
				id: 2,
				owner: { conversationId: 1, taskId: 10 },
				parent: { conversationId: 1, at: 100 },
			},
		},
		receipts: [
			{
				taskId: 5,
				conversationId: 1,
				kind: "pi.generation",
				outcome: "completed",
				endedAt: 2000,
				durationMs: 1000,
			},
		],
		stats: {
			liveCount: 1,
			terminalCount: 1,
			totalCount: 2,
		},
	};

	const parsed = runtimeGraphSnapshotSchema.safeParse(validSnapshot);
	assert.equal(parsed.success, true);
});

test("runtime-graph-contract: accepts native sleeping/until and blocked metadata", () => {
	const node = {
		id: 12,
		kind: "pi.tool",
		conversationId: 1,
		background: true,
		abortRequested: false,
		state: {
			status: "sleeping",
			until: 1750000000000,
			phase: "gather",
		},
		blocked: "restart_limit",
		label: "courier sleep until next phase",
	};

	const parsed = runtimeTaskNodeSchema.safeParse(node);
	assert.equal(parsed.success, true);
	if (parsed.success) {
		assert.equal(parsed.data.state.status, "sleeping");
		if (parsed.data.state.status === "sleeping") {
			assert.equal(parsed.data.state.until, 1750000000000);
		}
		assert.equal(parsed.data.blocked, "restart_limit");
	}
});

test("runtime-graph-contract: accepts waiting state with on and policy", () => {
	const node = {
		id: 15,
		kind: "pi.generation",
		conversationId: 1,
		background: false,
		abortRequested: false,
		state: {
			status: "waiting",
			on: [10, 11],
			policy: "all",
		},
		label: "waiting for tool execution",
	};

	const parsed = runtimeTaskNodeSchema.safeParse(node);
	assert.equal(parsed.success, true);
});

test("runtime-graph-contract: rejects invalid outcome in live state or receipt", () => {
	const invalidOutcome = {
		taskId: 20,
		conversationId: 1,
		kind: "pi.tool",
		outcome: "success", // NOT allowed! Must be completed | failed | aborted | faulted | orphaned
		endedAt: 3000,
	};

	const parsed = runtimeTaskReceiptSchema.safeParse(invalidOutcome);
	assert.equal(parsed.success, false);
});

test("runtime-graph-contract: validates snapshot without global Buffer (browser/UI environment)", () => {
	const validSnapshot = {
		version: 1,
		scope: {
			sessionId: "sess-1",
			rootConversationId: "1",
			buildId: "build-1",
		},
		observation: {
			epoch: "epoch-1",
			revision: 1,
			observedAt: 1000,
			completeness: "complete",
		},
		nodes: {},
		conversations: { "1": { id: 1 } },
		receipts: [],
		stats: {
			liveCount: 0,
			terminalCount: 0,
			totalCount: 0,
		},
	};

	const originalBuffer = globalThis.Buffer;
	try {
		// Simulate browser environment without global Buffer
		// @ts-expect-error simulating browser environment
		delete globalThis.Buffer;

		const parsed = runtimeGraphSnapshotSchema.safeParse(validSnapshot);
		assert.equal(parsed.success, true, "Snapshot must pass validation when Buffer is undefined");
	} finally {
		globalThis.Buffer = originalBuffer;
	}
});

test("runtime-graph-contract: accepts receipt with owner metadata", () => {
	const receiptWithOwner = {
		taskId: 20,
		conversationId: 1,
		owner: 10,
		kind: "bash",
		outcome: "completed",
		endedAt: 3000,
	};

	const parsed = runtimeTaskReceiptSchema.safeParse(receiptWithOwner);
	assert.equal(parsed.success, true);
	if (parsed.success) {
		assert.equal(parsed.data.owner, 10);
	}
});

