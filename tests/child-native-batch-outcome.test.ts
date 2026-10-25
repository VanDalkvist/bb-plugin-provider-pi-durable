import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BBChildEventAdapter } from "../src/runner/bridge/bb-child-event-adapter.ts";
import type { AgentEvent } from "@earendil-works/pi-durable";

describe("Child Native Batch Outcome Truth (Task 7)", () => {
	it("run_end followed by submission unanswered with reason aborted emits wire aborted", () => {
		const emitted: any[] = [];
		const adapter = new BBChildEventAdapter((ev) => emitted.push(ev), "parent_call_1", "conv_1");

		const batch: AgentEvent[] = [
			{ type: "run_start" } as any,
			{ type: "run_end", inputs: ["sub_1"] } as any,
			{
				type: "submission",
				record: { id: "sub_1", status: "unanswered", reason: "aborted" },
			} as any,
		];

		adapter.handleBatch(batch);

		const agentEnd = emitted.find((e) => e.type === "agent_end");
		assert.ok(agentEnd, "agent_end should be emitted");
		assert.equal(agentEnd.aborted, true);
		assert.equal(agentEnd.stopReason, "aborted");
	});

	it("run_end followed by submission unanswered with reason cancelled emits wire aborted", () => {
		const emitted: any[] = [];
		const adapter = new BBChildEventAdapter((ev) => emitted.push(ev), "parent_call_1", "conv_1");

		const batch: AgentEvent[] = [
			{ type: "run_start" } as any,
			{ type: "run_end", inputs: ["sub_2"] } as any,
			{
				type: "submission",
				record: { id: "sub_2", status: "unanswered", reason: "cancelled" },
			} as any,
		];

		adapter.handleBatch(batch);

		const agentEnd = emitted.find((e) => e.type === "agent_end");
		assert.ok(agentEnd);
		assert.equal(agentEnd.aborted, true);
		assert.equal(agentEnd.stopReason, "aborted");
	});

	it("DONE input submission wins over intermediate recoverable tool task_failed", () => {
		const emitted: any[] = [];
		const adapter = new BBChildEventAdapter((ev) => emitted.push(ev), "parent_call_1", "conv_1");

		const batch: AgentEvent[] = [
			{ type: "run_start" } as any,
			{ type: "task_failed", taskId: "t1", kind: "tool", message: "Recoverable tool error" } as any,
			{ type: "run_end", inputs: ["sub_3"] } as any,
			{
				type: "submission",
				record: { id: "sub_3", status: "done" },
			} as any,
		];

		adapter.handleBatch(batch);

		const agentEnd = emitted.find((e) => e.type === "agent_end");
		assert.ok(agentEnd);
		assert.notEqual(agentEnd.stopReason, "error", "DONE input must win over recoverable tool error");
		assert.equal(agentEnd.aborted, undefined);
	});

	it("unanswered submission without abort reason emits stopReason error with details", () => {
		const emitted: any[] = [];
		const adapter = new BBChildEventAdapter((ev) => emitted.push(ev), "parent_call_1", "conv_1");

		const batch: AgentEvent[] = [
			{ type: "run_start" } as any,
			{ type: "run_end", inputs: ["sub_4"] } as any,
			{
				type: "submission",
				record: { id: "sub_4", status: "unanswered", reason: "execution_error", detail: "Fatal model error" },
			} as any,
		];

		adapter.handleBatch(batch);

		const agentEnd = emitted.find((e) => e.type === "agent_end");
		assert.ok(agentEnd);
		assert.equal(agentEnd.stopReason, "error");
		assert.match(agentEnd.errorMessage ?? "", /Fatal model error/);
	});
});
