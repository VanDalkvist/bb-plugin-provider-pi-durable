import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeGraphReceiptsCollector } from "../src/runner/runtime-graph-receipts.ts";
import { mapTaskGraphNodeState } from "../src/runner/runtime-graph-mapper.ts";
import { taskLabel, TaskNames } from "../src/runner/task-labels.ts";
import { runtimeTaskReceiptSchema, runtimeTaskStateSchema } from "../src/runtime-graph/schema.ts";
import type { TaskRecord } from "@earendil-works/pi-durable";

test("runtime-graph-completing: recordTerminal unwraps object outcome on completing task", () => {
	const collector = new RuntimeGraphReceiptsCollector(128);

	const completingTask: TaskRecord<any, any, any> = {
		id: 13087 as any,
		conversationId: 1 as any,
		kind: "pi.tool",
		version: 2,
		input: { kind: "model", assistant: 13086, callId: "call_subagent" },
		owner: 13084 as any,
		background: false,
		abortRequested: false,
		startedAt: 1000,
		endedAt: 2000,
		state: {
			status: "completing",
			outcome: {
				status: "completed",
				result: { kind: "model", entryId: 13098 },
			},
		},
	};

	const receipt = collector.recordTerminal(completingTask);
	assert.equal(typeof receipt.outcome, "string");
	assert.equal(receipt.outcome, "completed");

	const validation = runtimeTaskReceiptSchema.safeParse(receipt);
	assert.equal(validation.success, true, `Validation failed: ${JSON.stringify(validation.error?.issues)}`);
});

test("runtime-graph-completing: recordTerminal extracts error from failing completing task", () => {
	const collector = new RuntimeGraphReceiptsCollector(128);

	const failedCompletingTask: TaskRecord<any, any, any> = {
		id: 13090 as any,
		conversationId: 1 as any,
		kind: "pi.tool",
		version: 2,
		input: {},
		background: false,
		abortRequested: false,
		state: {
			status: "completing",
			outcome: {
				status: "failed",
				error: { message: "Subagent aborted abnormally", code: "SUBAGENT_ABORT" },
			},
		},
	};

	const receipt = collector.recordTerminal(failedCompletingTask);
	assert.equal(receipt.outcome, "failed");
	assert.deepEqual(receipt.error, { message: "Subagent aborted abnormally", code: "SUBAGENT_ABORT" });

	const validation = runtimeTaskReceiptSchema.safeParse(receipt);
	assert.equal(validation.success, true);
});

test("runtime-graph-completing: mapTaskGraphNodeState normalizes object outcome safely", () => {
	const mapped = mapTaskGraphNodeState({
		status: "completing",
		outcome: { status: "completed", result: {} } as any,
	});

	assert.equal(mapped.status, "completing");
	assert.equal(mapped.outcome, "completed");

	const validation = runtimeTaskStateSchema.safeParse(mapped);
	assert.equal(validation.success, true);
});

test("runtime-graph-completing: taskLabel formats string outcome without object serialization", () => {
	const names = new TaskNames();
	const label = taskLabel(
		{
			id: 13087 as any,
			kind: "subagent",
			conversationId: 1 as any,
			background: false,
			abortRequested: false,
			conversations: [],
			state: {
				status: "completing",
				outcome: { status: "completed" } as any,
			},
		},
		names,
	);

	assert.ok(!label.includes("[object Object]"), `Label contained [object Object]: ${label}`);
	assert.ok(label.includes("completing (completed)"), `Unexpected label format: ${label}`);
});
