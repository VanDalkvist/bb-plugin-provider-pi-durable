import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeGraphReceiptsCollector } from "../src/runner/runtime-graph-receipts.ts";
import type { TaskRecord } from "@earendil-works/pi-durable";

test("runtime-graph-receipts: records terminal task with exact outcome and duration", () => {
	const collector = new RuntimeGraphReceiptsCollector(128);

	const taskRecord: TaskRecord<any, any, any> = {
		id: 10 as any,
		conversationId: 1 as any,
		kind: "pi.tool",
		version: 1,
		input: {},
		background: false,
		abortRequested: false,
		startedAt: 1000,
		endedAt: 2500,
		state: {
			status: "terminal",
			outcome: {
				status: "completed",
				result: { output: "done" },
			},
		},
	};

	const receipt = collector.recordTerminal(taskRecord, {
		isToolError: false,
		durationMs: 1500,
		preview: "done preview",
	});

	assert.equal(receipt.taskId, 10);
	assert.equal(receipt.conversationId, 1);
	assert.equal(receipt.outcome, "completed");
	assert.equal(receipt.isToolError, false);
	assert.equal(receipt.durationMs, 1500);
	assert.equal(receipt.preview, "done preview");

	const list = collector.getReceipts();
	assert.equal(list.length, 1);
	assert.equal(list[0]?.taskId, 10);
});

test("runtime-graph-receipts: preserves tool isError separately from task outcome", () => {
	const collector = new RuntimeGraphReceiptsCollector(128);

	const taskRecord: TaskRecord<any, any, any> = {
		id: 11 as any,
		conversationId: 1 as any,
		kind: "pi.tool",
		version: 1,
		input: {},
		background: false,
		abortRequested: false,
		startedAt: 1000,
		endedAt: 1200,
		state: {
			status: "terminal",
			outcome: {
				status: "completed", // Task executed and completed
				result: { isError: true, error: "file not found" },
			},
		},
	};

	const receipt = collector.recordTerminal(taskRecord, {
		isToolError: true, // Tool reported error
		preview: "Error: file not found",
	});

	assert.equal(receipt.outcome, "completed");
	assert.equal(receipt.isToolError, true);
});

test("runtime-graph-receipts: preserves exact failed/aborted/faulted/orphaned outcomes", () => {
	const collector = new RuntimeGraphReceiptsCollector(128);

	const failedTask: TaskRecord<any, any, any> = {
		id: 12 as any,
		conversationId: 1 as any,
		kind: "pi.tool",
		version: 1,
		input: {},
		background: false,
		abortRequested: false,
		endedAt: 2000,
		state: {
			status: "terminal",
			outcome: {
				status: "failed",
				error: { message: "Internal failure", code: "EXEC_FAIL" },
			},
		},
	};

	const receipt = collector.recordTerminal(failedTask);
	assert.equal(receipt.outcome, "failed");
	assert.deepEqual(receipt.error, { message: "Internal failure", code: "EXEC_FAIL" });
});

test("runtime-graph-receipts: bounds capacity to 128 items and evicts oldest", () => {
	const collector = new RuntimeGraphReceiptsCollector(128);

	for (let i = 1; i <= 130; i++) {
		const taskRecord: TaskRecord<any, any, any> = {
			id: i as any,
			conversationId: 1 as any,
			kind: "pi.tool",
			version: 1,
			input: {},
			background: false,
			abortRequested: false,
			endedAt: 1000 + i,
			state: {
				status: "terminal",
				outcome: { status: "completed", result: null },
			},
		};
		collector.recordTerminal(taskRecord);
	}

	const receipts = collector.getReceipts();
	assert.equal(receipts.length, 128);
	// First two (1 and 2) must have been evicted, 3 should be oldest now
	assert.equal(receipts[0]?.taskId, 3);
	assert.equal(receipts[127]?.taskId, 130);
});

test("runtime-graph-receipts: preserves native Pi Durable orphaned outcome when genuinely reported", () => {
	const collector = new RuntimeGraphReceiptsCollector(128);

	const orphanedTask: TaskRecord<any, any, any> = {
		id: 50 as any,
		conversationId: 1 as any,
		kind: "pi.tool",
		version: 1,
		input: {},
		background: false,
		abortRequested: false,
		endedAt: 5000,
		state: {
			status: "terminal",
			outcome: {
				status: "orphaned",
				reason: "Task definition migration unavailable",
			},
		},
	};

	const receipt = collector.recordTerminal(orphanedTask);
	assert.equal(receipt.taskId, 50);
	assert.equal(receipt.outcome, "orphaned");
	assert.deepEqual(receipt.error, { message: "Task definition migration unavailable" });
});

test("runtime-graph-receipts: preserves task owner on terminal receipt", () => {
	const collector = new RuntimeGraphReceiptsCollector(128);

	const taskWithOwner: TaskRecord<any, any, any> = {
		id: 25 as any,
		conversationId: 1 as any,
		owner: 10 as any,
		kind: "bash",
		version: 1,
		input: {},
		background: false,
		abortRequested: false,
		startedAt: 1000,
		endedAt: 2000,
		state: {
			status: "terminal",
			outcome: { status: "completed" },
		},
	};

	const receipt = collector.recordTerminal(taskWithOwner);
	assert.equal(receipt.taskId, 25);
	assert.equal(receipt.owner, 10);
});


