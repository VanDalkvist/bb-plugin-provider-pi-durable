import test from "node:test";
import assert from "node:assert/strict";
import { ToolEventProjector } from "../src/runner/bridge/tool-result-extractor.ts";
import { translateToolUpdate } from "../src/host/tool-delta-translator.ts";

test("Slice 2: Cumulative output snapshots, trimStart, and empty-set handling", () => {
	const p = new ToolEventProjector();
	const callId = "bash-1";

	const u1 = p.projectToolUpdate({ type: "tool_execution_update", toolCallId: callId, toolName: "bash", output: { append: "first\n" } } as any);
	assert.equal(u1?.partialResult, "first\n");

	const u2 = p.projectToolUpdate({ type: "tool_execution_update", toolCallId: callId, toolName: "bash", output: { append: "second\n" } } as any);
	assert.equal(u2?.partialResult, "first\nsecond\n");

	const u3 = p.projectToolUpdate({ type: "tool_execution_update", toolCallId: callId, toolName: "bash", output: { trimStart: 6, append: "third\n" } } as any);
	assert.equal(u3?.partialResult, "second\nthird\n");

	const uTrimOnly = p.projectToolUpdate({ type: "tool_execution_update", toolCallId: callId, toolName: "bash", output: { trimStart: 7 } } as any);
	assert.equal(uTrimOnly?.partialResult, "third\n");

	const uEmptySet = p.projectToolUpdate({ type: "tool_execution_update", toolCallId: callId, toolName: "bash", output: { set: "" } } as any);
	assert.ok(uEmptySet);
	assert.equal(uEmptySet?.partialResult, "");

	const delta = translateToolUpdate(uEmptySet as any);
	assert.ok(delta);
	assert.equal(delta?.kind, "command.outputSnapshot");
	assert.equal((delta as any)?.text, "");
});

test("Feedback Item 3: Metadata-only update must return retained snapshot, not empty string", () => {
	const p = new ToolEventProjector();
	const callId = "bash-meta";

	p.projectToolUpdate({
		type: "tool_execution_update",
		toolCallId: callId,
		toolName: "bash",
		output: { append: "first-output\n" },
	} as any);

	const metaUpdate = p.projectToolUpdate({
		type: "tool_execution_update",
		toolCallId: callId,
		toolName: "bash",
		details: { pid: 12345 },
	} as any);

	assert.ok(metaUpdate);
	assert.equal(
		metaUpdate?.partialResult,
		"first-output\n",
		"Metadata-only update must retain existing output snapshot, not wipe to empty string",
	);
});

test("Feedback Item 2: Canonical details null is an explicit clear, not fallback to buffered metadata", () => {
	const p = new ToolEventProjector();
	const callId = "subagent-null-clear";

	p.projectToolUpdate({
		type: "tool_execution_update",
		toolCallId: callId,
		toolName: "subagent",
		details: { conversationId: 111 },
	} as any);

	const end = p.projectToolEnd({
		type: "tool_execution_end",
		toolCallId: callId,
		toolName: "subagent",
		result: {
			taskId: "t-clear" as any,
			structuredOutput: "ok",
			details: null,
			isError: false,
			diagnostics: [],
		},
	} as any);

	assert.equal(
		end.details,
		null,
		"Explicit details: null must be preserved and must not resurrect buffered details { conversationId: 111 }",
	);
});

test("Slice 2: Interleaved calls and scoped instance isolation", () => {
	const p1 = new ToolEventProjector();
	const p2 = new ToolEventProjector();
	const callId = "call-shared-name";

	p1.projectToolUpdate({ type: "tool_execution_update", toolCallId: callId, toolName: "bash", output: { append: "p1 data" } } as any);
	p2.projectToolUpdate({ type: "tool_execution_update", toolCallId: callId, toolName: "bash", output: { append: "p2 data" } } as any);

	const end1 = p1.projectToolEnd({
		type: "tool_execution_end",
		toolCallId: callId,
		toolName: "bash",
		result: { taskId: "t1" as any, isError: false, diagnostics: [] },
	} as any);
	assert.equal(end1.result, "p1 data");

	const end2 = p2.projectToolEnd({
		type: "tool_execution_end",
		toolCallId: callId,
		toolName: "bash",
		result: { taskId: "t2" as any, isError: false, diagnostics: [] },
	} as any);
	assert.equal(end2.result, "p2 data");
});

test("Slice 2: Scoped state cleanup prevents stale details leakage after fault", () => {
	const p = new ToolEventProjector();
	const callId = "subagent-reuse-id";

	p.projectToolUpdate({ type: "tool_execution_update", toolCallId: callId, toolName: "subagent", details: { conversationId: 111 } } as any);
	const faulted = p.projectToolEnd({ type: "tool_execution_end", toolCallId: callId, toolName: "subagent" } as any);
	assert.equal(faulted.isError, true);

	const nextCall = p.projectToolEnd({
		type: "tool_execution_end",
		toolCallId: callId,
		toolName: "read",
		result: { taskId: "t" as any, structuredOutput: "content", isError: false, diagnostics: [] },
	} as any);
	assert.equal(nextCall.isError, false);
	assert.equal(nextCall.details, undefined);
});

test("Slice 2: Error output preserves available retained text plus diagnostics", () => {
	const p = new ToolEventProjector();
	const callId = "bash-error";

	p.projectToolUpdate({ type: "tool_execution_update", toolCallId: callId, toolName: "bash", output: { append: "progress before crash\n" } } as any);
	const end = p.projectToolEnd({
		type: "tool_execution_end",
		toolCallId: callId,
		toolName: "bash",
		result: {
			taskId: "t-err" as any,
			isError: true,
			diagnostics: [{ severity: "error", code: "exit_code", message: "Process exited with code 1" }],
		},
	} as any);
	assert.equal(end.isError, true);
	assert.match(end.result, /progress before crash/);
	assert.match(end.result, /Process exited with code 1/);
});

test("Slice 2: Snapshot seeding restores active slots cleanly", () => {
	const p = new ToolEventProjector();
	p.seedFromSnapshot(
		[{ callId: "seed-1", output: "seeded text", details: { conv: 99 } }],
		[{ callId: "seed-2", output: "nested seed" }],
	);

	const update = p.projectToolUpdate({ type: "tool_execution_update", toolCallId: "seed-1", toolName: "bash", output: { append: " appended" } } as any);
	assert.equal(update?.partialResult, "seeded text appended");

	p.clear();
	const afterClear = p.projectToolUpdate({ type: "tool_execution_update", toolCallId: "seed-2", toolName: "bash", output: { append: "new" } } as any);
	assert.equal(afterClear?.partialResult, "new");
});
