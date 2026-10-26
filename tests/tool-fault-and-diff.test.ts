import test from "node:test";
import assert from "node:assert/strict";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { BBEventAdapter } from "../src/runner/bridge/bb-event-adapter.ts";
import {
	translateToolStart,
	translateToolEnd,
} from "../src/host/tool-delta-translator.ts";
import type { DurableView } from "../src/runner/runtime-types.ts";
import type { BBWireEvent, BBToolExecutionEndEvent, BBToolExecutionUpdateEvent } from "../src/runner/bridge/contracts.ts";
import { viewFixture } from "./fixtures/durable.ts";

test("BBEventAdapter: tool_execution_end with missing entry and result emits isError: true with fault result (D-5)", () => {
    const emitted: BBWireEvent[] = [];
    const adapter = new BBEventAdapter((evt) => emitted.push(evt));
    const dummyView = viewFixture({});
    adapter.handleEvent({
        type: "tool_execution_end",
        toolCallId: "call_fault_1",
        toolName: "bash",
    } as any, dummyView);
    assert.equal(emitted.length, 1);
    const endEvt = emitted[0] as BBToolExecutionEndEvent;
    assert.equal(endEvt.type, "tool_execution_end");
    assert.equal(endEvt.toolCallId, "call_fault_1");
    assert.equal(endEvt.toolName, "bash");
    assert.equal(endEvt.isError, true);
    assert.match(endEvt.result, /without generating an entry record or nested result/i);
});

test("BBEventAdapter: tool_execution_end with valid entry and isError: false emits clean result", () => {
    const emitted: BBWireEvent[] = [];
    const adapter = new BBEventAdapter((evt) => emitted.push(evt));
    const dummyView = viewFixture({});
    adapter.handleEvent({
        type: "tool_execution_end",
        toolCallId: "call_read_1",
        toolName: "read",
        entry: {
            kind: "toolResult",
            model: [
                {
                    role: "toolResult",
                    toolCallId: "call_read_1",
                    toolName: "read",
                    content: [{ type: "text", text: "file content lines" }],
                    isError: false,
                },
            ],
        } as any,
    }, dummyView);
    assert.equal(emitted.length, 1);
    const endEvt = emitted[0] as BBToolExecutionEndEvent;
    assert.equal(endEvt.type, "tool_execution_end");
    assert.equal(endEvt.toolCallId, "call_read_1");
    assert.equal(endEvt.result, "file content lines");
    assert.equal(endEvt.isError, false);
});

test("BBEventAdapter: tool_execution_end with explicit error preserves isError: true", () => {
    const emitted: BBWireEvent[] = [];
    const adapter = new BBEventAdapter((evt) => emitted.push(evt));
    const dummyView = viewFixture({});
    adapter.handleEvent({
        type: "tool_execution_end",
        toolCallId: "call_err_1",
        toolName: "bash",
        entry: {
            kind: "toolResult",
            model: [
                {
                    role: "toolResult",
                    toolCallId: "call_err_1",
                    toolName: "bash",
                    content: [{ type: "text", text: "command failed with code 1" }],
                    isError: true,
                },
            ],
        } as any,
    }, dummyView);
    assert.equal(emitted.length, 1);
    const endEvt = emitted[0] as BBToolExecutionEndEvent;
    assert.equal(endEvt.type, "tool_execution_end");
    assert.equal(endEvt.result, "command failed with code 1");
    assert.equal(endEvt.isError, true);
});

test("BBEventAdapter: tool_execution_update forwards trimStart when present (D-9)", () => {
    const emitted: BBWireEvent[] = [];
    const adapter = new BBEventAdapter((evt) => emitted.push(evt));
    const dummyView = viewFixture({});
    adapter.handleEvent({
        type: "tool_execution_update",
        toolCallId: "call_stream_1",
        toolName: "bash",
        output: {
            trimStart: 256,
            append: "tail chunk\n",
        },
    }, dummyView);
    assert.equal(emitted.length, 1);
    const updateEvt = emitted[0] as BBToolExecutionUpdateEvent;
    assert.equal(updateEvt.type, "tool_execution_update");
    assert.equal(updateEvt.toolCallId, "call_stream_1");
    assert.equal(updateEvt.toolName, "bash");
    assert.equal(updateEvt.partialResult, "tail chunk\n");
    assert.equal(updateEvt.trimStart, 256);
});

test("tool-delta-translator: maps faulted tool end to failed item status with error message (D-5)", () => {
	const start = translateToolStart(
		{
			type: "tool_execution_start",
			toolCallId: "call_bash_fault",
			toolName: "bash",
			args: { command: "curl -fail http://internal/service" },
		},
		"/workspace",
	);

	const endDelta = translateToolEnd(
		{
			type: "tool_execution_end",
			toolCallId: "call_bash_fault",
			toolName: "bash",
			result: "Tool execution faulted or was orphaned without generating an entry record.",
			isError: true,
		},
		start.shape,
		"/workspace",
	);

	assert.equal(endDelta.kind, "item.close");
	assert.equal(endDelta.status, "failed");
	assert.equal(endDelta.exitCode, 1);
	assert.equal(
		endDelta.resultText,
		"Tool execution faulted or was orphaned without generating an entry record.",
	);
	assert.deepEqual(endDelta.error, {
		message: "Tool execution faulted or was orphaned without generating an entry record.",
	});

	const parsed = threadDeltaSchema.safeParse(endDelta);
	assert.equal(parsed.success, true);
});
