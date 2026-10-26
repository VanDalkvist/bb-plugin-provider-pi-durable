import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DeltaTranslator } from "../src/host/delta-translator.ts";
import { BBEventAdapter } from "../src/runner/bridge/bb-event-adapter.ts";
import { BBChildEventAdapter } from "../src/runner/bridge/bb-child-event-adapter.ts";
import type { AgentEvent } from "@earendil-works/pi-durable";
import type { DurableView } from "../src/runner/runtime-types.ts";
import type { BBWireEvent } from "../src/runner/bridge/contracts.ts";
import { viewFixture } from "./fixtures/durable.ts";
import { publicDeltaFixture, wireFixture } from "./fixtures/wire.ts";

describe("Codemode Hierarchy and Delegation Parity (Cycle 103)", () => {
    it("BBEventAdapter: suppresses parentRef when nested tools execute inside codemode", () => {
        const wireEvents: BBWireEvent[] = [];
        const adapter = new BBEventAdapter((evt) => wireEvents.push(evt));
        const dummyView = viewFixture({});
        adapter.handleEvent({ type: "run_start", inputs: [] }, dummyView);
        // 1. Codemode tool starts at root level
        adapter.handleEvent({
            type: "tool_execution_start",
            toolCallId: "call_code_10",
            toolName: "codemode",
            args: { code: "const res = await tools.bash({ command: 'ls' });" },
        }, dummyView);
        // 2. Nested bash tool executes with parentToolCallId pointing to codemode
        adapter.handleEvent({
            type: "tool_execution_start",
            toolCallId: "call_bash_nested",
            toolName: "bash",
            args: { command: "ls -la" },
            parentToolCallId: "call_code_10",
        }, dummyView);
        // 3. Nested bash tool updates output
        adapter.handleEvent({
            type: "tool_execution_update",
            toolCallId: "call_bash_nested",
            toolName: "bash",
            output: { append: "total 42\n" },
            parentToolCallId: "call_code_10",
        }, dummyView);
        // 4. Nested bash tool ends with native result (NOT entry)
        adapter.handleEvent({
            type: "tool_execution_end",
            toolCallId: "call_bash_nested",
            toolName: "bash",
            result: {
                taskId: "t_bash_nested" as any,
                structuredOutput: "total 42\n",
                isError: false,
                diagnostics: [],
            },
            parentToolCallId: "call_code_10",
        } as any, dummyView);
        const nestedStart = wireEvents.find((e) => e.type === "tool_execution_start" && e.toolCallId === "call_bash_nested") as Record<string, unknown> | undefined;
        const nestedUpdate = wireEvents.find((e) => e.type === "tool_execution_update" && e.toolCallId === "call_bash_nested") as Record<string, unknown> | undefined;
        const nestedEnd = wireEvents.find((e) => e.type === "tool_execution_end" && e.toolCallId === "call_bash_nested") as Record<string, unknown> | undefined;
        assert.ok(nestedStart, "Nested bash start event must be emitted");
        assert.equal(nestedStart.parentRef, undefined, "parentRef must be suppressed on nested tools inside codemode to prevent subagent projection");
        assert.ok(nestedUpdate, "Nested bash update event must be emitted");
        assert.equal(nestedUpdate.parentRef, undefined, "parentRef must be suppressed on update");
        assert.ok(nestedEnd, "Nested bash end event must be emitted");
        assert.equal(nestedEnd.parentRef, undefined, "parentRef must be suppressed on end");
        assert.equal(nestedEnd.isError, false);
        assert.equal(nestedEnd.result, "total 42\n");
    });
    it("DeltaTranslator: defense-in-depth drops parentRef if parent tool was codemode", () => {
        const translator = new DeltaTranslator();
        const ctx = { threadId: "thr_test", cwd: "/tmp" };
        // 1. Start codemode tool
        const codeStartDeltas = translator.translate(wireFixture("tool_execution_start", {
            type: "tool_execution_start",
            toolCallId: "call_code_parent",
            toolName: "codemode",
            args: { code: "// Execute test\nawait tools.read({ path: 'test.txt' })" },
        }), ctx);
        assert.equal(codeStartDeltas.length, 1);
        const started = publicDeltaFixture(codeStartDeltas[0]);
        assert.ok(started.kind === "item.open");
        assert.equal(started.item.type, "tool");
        // 2. Child tool arrives with parentRef explicitly pointing to codemode
        const childDeltas = translator.translate(wireFixture("tool_execution_start", {
            type: "tool_execution_start",
            parentRef: "call_code_parent",
            toolCallId: "call_read_child",
            toolName: "read",
            args: { path: "test.txt" },
        }), ctx);
        assert.equal(childDeltas.length, 1);
        const childDelta = childDeltas[0];
        assert.equal((childDelta.key as Record<string, unknown>).parentRef, undefined, "DeltaTranslator must drop parentRef when parent tool is codemode");
        assert.equal((childDelta.item as Record<string, unknown>).parentToolCallId, undefined, "Delta item must not carry parentToolCallId pointing to codemode");
    });
    it("Subagent delegation parity: subagent delegations strictly retain Bot presentation and child parentRef", () => {
        const emitted: BBWireEvent[] = [];
        const childAdapter = new BBChildEventAdapter((evt) => emitted.push(evt), "call_subagent_99");
        childAdapter.handleEvent({
            type: "tool_execution_start",
            toolCallId: "call_nested_tool",
            toolName: "bash",
            args: { command: "npm test" },
        } as AgentEvent);
        assert.equal(emitted.length, 1);
        const wireEvt = emitted[0] as Record<string, unknown>;
        assert.equal(wireEvt.parentRef, "call_subagent_99");
        assert.equal(wireEvt.toolCallId, "call_subagent_99:call_nested_tool");
    });
});
