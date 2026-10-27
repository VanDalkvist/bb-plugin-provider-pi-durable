import test from "node:test";
import assert from "node:assert/strict";
import {
	RuntimeGraphReceiptsCollector,
	MAX_ERROR_MESSAGE_LENGTH,
	MAX_ERROR_CODE_LENGTH,
} from "../src/runner/runtime-graph-receipts.ts";
import { mapTaskGraphNodeState } from "../src/runner/runtime-graph-mapper.ts";
import { taskLabel, TaskNames } from "../src/runner/task-labels.ts";
import { runtimeTaskReceiptSchema, runtimeTaskStateSchema, MAX_PREVIEW_LENGTH } from "../src/runtime-graph/schema.ts";
import { RuntimeGraphSource } from "../src/runner/runtime-graph-source.ts";
import type { TaskRecord } from "@earendil-works/pi-durable";

test("runtime-graph-completing: completing task remains live and is NOT recorded in terminal receipts", () => {
	const collector = new RuntimeGraphReceiptsCollector(128);
	const completingTask: TaskRecord<any, any, any> = {
		id: 13087 as any, conversationId: 1 as any, kind: "pi.tool", version: 2,
		input: { kind: "model", assistant: 13086, callId: "call_subagent" }, owner: 13084 as any,
		background: false, abortRequested: false, startedAt: 1000, endedAt: 2000,
		state: { status: "completing", outcome: { status: "completed", result: { entryId: 13098 } } },
	};
	const receipt = collector.recordTerminal(completingTask);
	assert.equal(receipt, undefined, "Completing task must not produce a terminal receipt");
	assert.equal(collector.getReceipts().length, 0, "Receipts collector must remain empty for completing task");
});

test("runtime-graph-completing: true terminal transition records receipt with owner and unwraps outcome", () => {
	const collector = new RuntimeGraphReceiptsCollector(128);
	const terminalTask: TaskRecord<any, any, any> = {
		id: 13087 as any, conversationId: 1 as any, kind: "pi.tool", version: 2, input: {},
		owner: 13084 as any, background: false, abortRequested: false, startedAt: 1000, endedAt: 2000,
		state: { status: "terminal", outcome: { status: "completed", result: { done: true } } },
	};
	const receipt = collector.recordTerminal(terminalTask);
	assert.ok(receipt, "Terminal task must produce receipt");
	assert.equal(receipt.outcome, "completed");
	assert.equal(receipt.owner, 13084, "Authoritative owner metadata must be preserved");
	assert.equal(collector.getReceipts().length, 1);
	assert.equal(runtimeTaskReceiptSchema.safeParse(receipt).success, true);
});

test("runtime-graph-completing: bounds error message, code and preview within schema limits", () => {
	const collector = new RuntimeGraphReceiptsCollector(128);
	const failedTerminalTask: TaskRecord<any, any, any> = {
		id: 13090 as any, conversationId: 1 as any, kind: "pi.tool", version: 2, input: {},
		background: false, abortRequested: false,
		state: {
			status: "terminal",
			outcome: { status: "failed", error: { message: "E".repeat(5000), code: "C".repeat(200) } },
		},
	};
	const receipt = collector.recordTerminal(failedTerminalTask, { preview: "P".repeat(1000) });
	assert.ok(receipt);
	assert.equal(receipt.outcome, "failed");
	assert.equal(receipt.error?.message.length, MAX_ERROR_MESSAGE_LENGTH);
	assert.equal(receipt.error?.code?.length, MAX_ERROR_CODE_LENGTH);
	assert.equal(receipt.preview?.length, MAX_PREVIEW_LENGTH);
	assert.equal(runtimeTaskReceiptSchema.safeParse(receipt).success, true);
});

test("runtime-graph-completing: unwraps reason on aborted terminal task and bounds length", () => {
	const collector = new RuntimeGraphReceiptsCollector(128);
	const abortedTask: TaskRecord<any, any, any> = {
		id: 13091 as any, conversationId: 1 as any, kind: "pi.tool", version: 2, input: {},
		background: false, abortRequested: true,
		state: { status: "terminal", outcome: { status: "aborted", reason: "User cancelled ".repeat(200) } },
	};
	const receipt = collector.recordTerminal(abortedTask);
	assert.ok(receipt);
	assert.equal(receipt.outcome, "aborted");
	assert.ok(receipt.error?.message.length! <= 1024);
	assert.equal(runtimeTaskReceiptSchema.safeParse(receipt).success, true);
});

test("runtime-graph-completing: re-commit and duplicates update in-place without duplicating receipts", () => {
	const collector = new RuntimeGraphReceiptsCollector(128);
	const task: TaskRecord<any, any, any> = {
		id: 999 as any, conversationId: 1 as any, kind: "pi.tool", version: 1, input: {},
		state: { status: "terminal", outcome: { status: "completed" } },
	};
	collector.recordTerminal(task, { preview: "first" });
	assert.equal(collector.getReceipts().length, 1);
	assert.equal(collector.getReceipts()[0]?.preview, "first");

	collector.recordTerminal(task, { preview: "updated" });
	assert.equal(collector.getReceipts().length, 1, "Duplicate commit must not increase receipts count");
	assert.equal(collector.getReceipts()[0]?.preview, "updated", "Duplicate commit must update receipt in-place");
});

test("runtime-graph-completing: mapTaskGraphNodeState normalizes prospective outcomes safely", () => {
	for (const prospective of ["completed", "failed", "aborted"] as const) {
		const mapped = mapTaskGraphNodeState({ status: "completing", outcome: { status: prospective, result: {} } as any });
		assert.equal(mapped.status, "completing");
		assert.equal(mapped.outcome, prospective);
		assert.equal(runtimeTaskStateSchema.safeParse(mapped).success, true);
	}
});

test("runtime-graph-completing: taskLabel formats string outcome without object serialization", () => {
	const names = new TaskNames();
	const label = taskLabel(
		{
			id: 13087 as any, kind: "subagent", conversationId: 1 as any, background: false,
			abortRequested: false, conversations: [],
			state: { status: "completing", outcome: { status: "completed" } as any },
		},
		names,
	);
	assert.ok(!label.includes("[object Object]"), `Label contained [object Object]: ${label}`);
	assert.ok(label.includes("completing (completed)"), `Unexpected label format: ${label}`);
});

test("runtime-graph-completing negative controls: schema rejects invalid outcomes and oversized payloads", () => {
	const outcomeRes = runtimeTaskReceiptSchema.safeParse({
		taskId: 1, conversationId: 1, kind: "bash", outcome: "unknown_custom", endedAt: 2000,
	});
	assert.equal(outcomeRes.success, false, "Schema must reject foreign outcome enum");

	const msgRes = runtimeTaskReceiptSchema.safeParse({
		taskId: 2, conversationId: 1, kind: "bash", outcome: "failed", error: { message: "X".repeat(1025) }, endedAt: 2000,
	});
	assert.equal(msgRes.success, false, "Schema must reject error message exceeding 1024 chars");

	const codeRes = runtimeTaskReceiptSchema.safeParse({
		taskId: 3, conversationId: 1, kind: "bash", outcome: "failed", error: { message: "Failed", code: "C".repeat(65) }, endedAt: 2000,
	});
	assert.equal(codeRes.success, false, "Schema must reject error code exceeding 64 chars");

	const stateRes = runtimeTaskStateSchema.safeParse({ status: "completing", outcome: "invalid_status" });
	assert.equal(stateRes.success, false, "Schema must reject invalid completing outcome");
});

test("runtime-graph-completing: RuntimeGraphSource does not double-count completing task in stats", async () => {
	let current: any = {
		tasks: {
			"40": {
				id: 40, kind: "pi.tool", conversationId: 1, background: false, abortRequested: false,
				state: { status: "completing", outcome: { status: "completed" } }, conversations: [],
			},
		},
	};
	const listeners = new Set<() => void>();
	const viewSource = {
		current: () => current,
		update: (next: any) => { current = next; for (const l of listeners) l(); },
		subscribe: (l: () => void) => { listeners.add(l); return () => listeners.delete(l); },
	};
	const snapshots: any[] = [];
	let commitListener: ((pub: { changes: readonly any[] }) => void) | undefined;
	const mockHarness = {
		subscribeCommits: (listener: any) => { commitListener = listener; return () => {}; },
		getTask: async () => undefined,
	};
	const source = new RuntimeGraphSource(
		viewSource as any, { sessionId: "s1", rootConversationId: "1", buildId: "b1" },
		{ debounceMs: 10, harness: mockHarness },
	);
	source.subscribe((s) => snapshots.push(s));
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(snapshots[0]?.stats.liveCount, 1);
	assert.equal(snapshots[0]?.stats.terminalCount, 0);
	assert.equal(snapshots[0]?.stats.totalCount, 1, "Completing task must not double count in stats");

	commitListener?.({
		changes: [{
			type: "task",
			value: { id: 40, conversationId: 1, kind: "pi.tool", state: { status: "completing", outcome: { status: "completed" } } },
		}],
	});
	await new Promise((r) => setTimeout(r, 30));
	const mid = snapshots[snapshots.length - 1];
	assert.equal(mid?.stats.terminalCount, 0, "Completing commit must NOT create terminal receipt");
	assert.equal(mid?.stats.totalCount, 1);

	commitListener?.({
		changes: [{
			type: "task",
			value: { id: 40, conversationId: 1, kind: "pi.tool", endedAt: 2000, state: { status: "terminal", outcome: { status: "completed" } } },
		}],
	});
	viewSource.update({ tasks: {} });
	await new Promise((r) => setTimeout(r, 30));
	const final = snapshots[snapshots.length - 1];
	assert.equal(final?.stats.liveCount, 0);
	assert.equal(final?.stats.terminalCount, 1);
	assert.equal(final?.stats.totalCount, 1, "Settled task must have totalCount 1");
	source.teardown();
});
