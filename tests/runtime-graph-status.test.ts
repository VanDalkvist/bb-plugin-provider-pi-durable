import test from "node:test";
import assert from "node:assert/strict";
import {
	projectTaskState,
	projectTaskReceipt,
} from "../src/runtime-graph/status.ts";
import type {
	RuntimeTaskNode,
	RuntimeTaskReceipt,
} from "../src/runtime-graph/types.ts";

test("runtime-graph-status: completing status is NOT final success", () => {
	const node: RuntimeTaskNode = {
		id: 10,
		kind: "pi.tool",
		conversationId: 1,
		background: false,
		abortRequested: false,
		state: {
			status: "completing",
			outcome: "completed",
		},
		label: "subagent call",
	};

	const projected = projectTaskState(node);
	assert.equal(projected.rawStatus, "completing");
	assert.equal(projected.isFinal, false);
	assert.equal(projected.isCompleting, true);
	assert.equal(projected.label, "Completing child work");
});

test("runtime-graph-status: abortRequested does NOT rewrite status to aborted", () => {
	const node: RuntimeTaskNode = {
		id: 11,
		kind: "pi.tool",
		conversationId: 1,
		background: false,
		abortRequested: true,
		state: {
			status: "running",
			phase: "execute",
		},
		label: "long bash command",
	};

	const projected = projectTaskState(node);
	assert.equal(projected.rawStatus, "running");
	assert.equal(projected.isFinal, false);
	assert.equal(projected.abortRequested, true);
});

test("runtime-graph-status: sleeping status preserves deadline until", () => {
	const deadline = Date.now() + 5000;
	const node: RuntimeTaskNode = {
		id: 12,
		kind: "bb.subagent-courier",
		conversationId: 1,
		background: true,
		abortRequested: false,
		state: {
			status: "sleeping",
			until: deadline,
			phase: "gather",
		},
		label: "courier sleep",
	};

	const projected = projectTaskState(node);
	assert.equal(projected.rawStatus, "sleeping");
	assert.equal(projected.isFinal, false);
	assert.equal(projected.sleepUntil, deadline);
});

test("runtime-graph-status: waiting status preserves dependency on task IDs", () => {
	const node: RuntimeTaskNode = {
		id: 14,
		kind: "pi.generation",
		conversationId: 1,
		background: false,
		abortRequested: false,
		state: {
			status: "waiting",
			on: [10, 11],
			policy: "all",
		},
		label: "waiting for tools",
	};

	const projected = projectTaskState(node);
	assert.equal(projected.rawStatus, "waiting");
	assert.equal(projected.isFinal, false);
	assert.deepEqual(projected.waitingOn, [10, 11]);
});

test("runtime-graph-status: tool isError does NOT rewrite receipt task outcome", () => {
	const receiptWithToolError: RuntimeTaskReceipt = {
		taskId: 20,
		conversationId: 1,
		kind: "pi.tool",
		outcome: "completed",
		isToolError: true,
		endedAt: 2500,
		durationMs: 450,
	};

	const projected = projectTaskReceipt(receiptWithToolError);
	assert.equal(projected.outcome, "completed"); // Task outcome stays completed!
	assert.equal(projected.isFinal, true);
	assert.equal(projected.hasToolError, true); // Distinct tool error badge!
});

test("runtime-graph-status: receipt outcomes preserve exact failed/aborted/faulted/orphaned", () => {
	const outcomes = ["failed", "aborted", "faulted", "orphaned"] as const;
	for (const outcome of outcomes) {
		const receipt: RuntimeTaskReceipt = {
			taskId: 30,
			conversationId: 1,
			kind: "pi.tool",
			outcome,
			endedAt: 3000,
		};
		const projected = projectTaskReceipt(receipt);
		assert.equal(projected.outcome, outcome);
		assert.equal(projected.isFinal, true);
		assert.equal(projected.hasToolError, false);
	}
});
