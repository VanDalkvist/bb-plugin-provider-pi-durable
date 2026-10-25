import test from "node:test";
import assert from "node:assert/strict";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { BBEventAdapter } from "../src/runner/bridge/bb-event-adapter.ts";
import {
	translateToolStart,
	translateToolEnd,
} from "../src/host/tool-delta-translator.ts";
import type { DurableView } from "../src/runner/runtime.ts";
import type { BBWireEvent, BBToolExecutionEndEvent } from "../src/runner/bridge/contracts.ts";

test("BBEventAdapter: tool_execution_end forwards canonical details from model[0].details (D-6)", () => {
	const emitted: BBWireEvent[] = [];
	const adapter = new BBEventAdapter((evt) => emitted.push(evt));
	const dummyView = {} as DurableView;

	const diffDetails = { diff: "@@ -1 +1 @@\n-a\n+b\n", patch: "patch string" };

	adapter.handleEvent(
		{
			type: "tool_execution_end",
			toolCallId: "call_edit_1",
			toolName: "edit",
			entry: {
				kind: "toolResult",
				data: { diagnostics: [] },
				model: [
					{
						role: "toolResult",
						content: [{ type: "text", text: "applied patch" }],
						isError: false,
						details: diffDetails,
					},
				],
			} as any,
		},
		dummyView,
	);

	assert.equal(emitted.length, 1);
	const endEvt = emitted[0] as BBToolExecutionEndEvent;
	assert.deepEqual(endEvt.details, diffDetails);
});

test("BBEventAdapter: nested tool_execution_end forwards canonical details from result.details", () => {
	const emitted: BBWireEvent[] = [];
	const adapter = new BBEventAdapter((evt) => emitted.push(evt));
	const dummyView = {} as DurableView;

	const diffDetails = { diff: "@@ -1 +1 @@\n-x\n+y\n", patch: "nested patch" };

	adapter.handleEvent(
		{
			type: "tool_execution_end",
			toolCallId: "call_nested_edit",
			toolName: "edit",
			result: {
				taskId: "t_nested_1" as any,
				structuredOutput: "nested applied patch",
				isError: false,
				details: diffDetails,
				diagnostics: [],
			},
		} as any,
		dummyView,
	);

	assert.equal(emitted.length, 1);
	const endEvt = emitted[0] as BBToolExecutionEndEvent;
	assert.deepEqual(endEvt.details, diffDetails);
	assert.equal(endEvt.isError, false);
});

test("tool-delta-translator: enriches fileChange item with diff metadata and validates with threadDeltaSchema (D-6)", () => {
	const start = translateToolStart(
		{
			type: "tool_execution_start",
			toolCallId: "call_edit_diff",
			toolName: "edit",
			args: {
				path: "/workspace/src/app.ts",
				edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
			},
		},
		"/workspace",
	);

	const diffText = "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n";
	const endDelta = translateToolEnd(
		{
			type: "tool_execution_end",
			toolCallId: "call_edit_diff",
			toolName: "edit",
			result: "Successfully modified /workspace/src/app.ts",
			isError: false,
			details: { diff: diffText },
		},
		start.shape,
		"/workspace",
	);

	assert.equal(endDelta.kind, "item.close");
	assert.equal(endDelta.status, "completed");
	assert.equal(endDelta.exitCode, 0);

	const item = endDelta.item as { type: string; changes: Array<{ path: string; kind: string; diff?: string }> };
	assert.equal(item.type, "fileChange");
	assert.equal(item.changes.length, 1);
	assert.equal(item.changes[0].diff, diffText);

	const parsed = threadDeltaSchema.safeParse(endDelta);
	assert.equal(parsed.success, true);
});
