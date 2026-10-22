import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import {
	extractCodemodeTitle,
	getCodemodePresentation,
	resolveToolPresentation,
} from "../src/host/tool-presentations.ts";
import {
	buildToolItemShape,
	translateToolStart,
	translateToolUpdate,
	translateToolEnd,
} from "../src/host/tool-delta-translator.ts";
import { DeltaTranslator } from "../src/host/delta-translator.ts";
import { BBEventAdapter } from "../src/runner/bridge/bb-event-adapter.ts";
import { BBChildEventAdapter } from "../src/runner/bridge/bb-child-event-adapter.ts";
import type { AgentEvent } from "@earendil-works/pi-durable";
import type { DurableView } from "../src/runner/runtime.ts";
import type { BBWireEvent } from "../src/runner/bridge/contracts.ts";

describe("Codemode Presentation and Hierarchy Parity (Cycle 103)", () => {
	it("extractCodemodeTitle: extracts title from comments, handles options header, and falls back cleanly", () => {
		// 1. Direct comment
		const title1 = extractCodemodeTitle("// Check Mihomo VPN config\nconst res = await tools.bash(...)");
		assert.equal(title1, "Check Mihomo VPN config");

		// 2. Options header followed by comment
		const title2 = extractCodemodeTitle(
			'// @options: {"max_output_tokens": 10000}\n// Run thread health audit\nawait tools.bash(...)',
		);
		assert.equal(title2, "Run thread health audit");

		// 3. Multi-line block comment
		const title3 = extractCodemodeTitle("/* Inspect service daemon */\nconst list = await tools.bash(...)");
		assert.equal(title3, "Inspect service daemon");

		// 4. Code fallback when no comment line exists
		const title4 = extractCodemodeTitle("const status = await tools.bash({ command: 'git status' });");
		assert.equal(title4, "const status = await tools.bash({ command: 'git status' });");

		// 5. Length ceiling at 80 characters with ellipsis
		const longLine = "// " + "A".repeat(100);
		const title5 = extractCodemodeTitle(longLine);
		assert.equal(title5.length, 80);
		assert.ok(title5.endsWith("..."));

		// 6. Empty / non-string fallback
		assert.equal(extractCodemodeTitle(""), "Code execution");
		assert.equal(extractCodemodeTitle("   \n\n  "), "Code execution");
		assert.equal(extractCodemodeTitle(undefined), "Code execution");
		assert.equal(extractCodemodeTitle(null), "Code execution");
	});

	it("getCodemodePresentation: produces BB-compliant Code glyph and label pair", () => {
		const pres = getCodemodePresentation({
			code: "// Verify process health\nawait tools.bash({ command: 'ps aux' })",
		});
		assert.deepEqual(pres.label, { pending: "Running code", completed: "Ran code" });
		assert.deepEqual(pres.icon, { glyph: "Code" });
		assert.equal(pres.title, "Verify process health");
	});

	it("translateToolStart: codemode renders as tool item with Code presentation and no delegation copy", () => {
		const event = {
			type: "tool_execution_start" as const,
			toolCallId: "call_code_1",
			toolName: "codemode",
			args: {
				code: "// Check service status\nconst res = await tools.bash({ command: 'pm2 status' });",
			},
		};

		const { shape, delta } = translateToolStart(event, "/tmp");

		assert.equal(shape.type, "tool");
		assert.equal(shape.tool, "codemode");
		assert.equal(shape.server, "pi");

		assert.equal(delta.kind, "item.open");
		assert.equal(delta.item?.type, "tool");
		assert.equal(delta.key.parentRef, undefined);
		assert.equal((delta.item as Record<string, unknown>).parentToolCallId, undefined);

		// Presentation must carry Code glyph and Running code label
		const pres = delta.presentation as Record<string, unknown>;
		assert.ok(pres, "Codemode delta must include presentation metadata");
		assert.deepEqual(pres.icon, { glyph: "Code" });
		assert.deepEqual(pres.label, { pending: "Running code", completed: "Ran code" });
		assert.equal(pres.title, "Check service status");

		const parsed = threadDeltaSchema.safeParse(delta);
		assert.ok(parsed.success, `Delta must conform to BB schema: ${JSON.stringify(parsed)}`);
	});

	it("translateToolEnd: codemode closes cleanly with Code presentation and completed status", () => {
		const cachedShape = buildToolItemShape(
			"codemode",
			{ code: "// Inspect logs\nawait tools.bash({ command: 'tail -n 20' })" },
			"/tmp",
		);

		const endEvent = {
			type: "tool_execution_end" as const,
			toolCallId: "call_code_1",
			toolName: "codemode",
			result: "Script completed\nWall time 2.1s\nOutput:\nOK",
			isError: false,
		};

		const delta = translateToolEnd(endEvent, cachedShape, "/tmp");

		assert.equal(delta.kind, "item.close");
		assert.equal(delta.status, "completed");
		assert.equal(delta.item?.type, "tool");
		assert.equal(delta.key.parentRef, undefined);
		assert.equal((delta.item as Record<string, unknown>).parentToolCallId, undefined);

		const pres = delta.presentation as Record<string, unknown>;
		assert.ok(pres);
		assert.deepEqual(pres.icon, { glyph: "Code" });
		assert.equal(pres.title, "Inspect logs");

		const parsed = threadDeltaSchema.safeParse(delta);
		assert.ok(parsed.success, `Delta must conform to BB schema: ${JSON.stringify(parsed)}`);
	});

	it("BBEventAdapter: suppresses parentRef when nested tools execute inside codemode", () => {
		const wireEvents: BBWireEvent[] = [];
		const adapter = new BBEventAdapter((evt) => wireEvents.push(evt));
		const dummyView = {} as DurableView;

		adapter.handleEvent({ type: "run_start" }, dummyView);

		// 1. Codemode tool starts at root level
		adapter.handleEvent(
			{
				type: "tool_execution_start",
				toolCallId: "call_code_10",
				toolName: "codemode",
				args: { code: "const res = await tools.bash({ command: 'ls' });" },
			},
			dummyView,
		);

		// 2. Nested bash tool executes with parentToolCallId pointing to codemode
		adapter.handleEvent(
			{
				type: "tool_execution_start",
				toolCallId: "call_bash_nested",
				toolName: "bash",
				args: { command: "ls -la" },
				parentToolCallId: "call_code_10",
			},
			dummyView,
		);

		// 3. Nested bash tool updates output
		adapter.handleEvent(
			{
				type: "tool_execution_update",
				toolCallId: "call_bash_nested",
				toolName: "bash",
				output: { append: "total 42\n" },
				parentToolCallId: "call_code_10",
			},
			dummyView,
		);

		// 4. Nested bash tool ends
		adapter.handleEvent(
			{
				type: "tool_execution_end",
				toolCallId: "call_bash_nested",
				toolName: "bash",
				entry: {
					model: [
						{
							role: "toolResult",
							toolCallId: "call_bash_nested",
							toolName: "bash",
							content: [{ type: "text", text: "total 42\n" }],
							isError: false,
						},
					],
				} as any,
				parentToolCallId: "call_code_10",
			},
			dummyView,
		);

		// Find the nested tool wire events
		const nestedStart = wireEvents.find(
			(e) => e.type === "tool_execution_start" && e.toolCallId === "call_bash_nested",
		) as Record<string, unknown> | undefined;
		const nestedUpdate = wireEvents.find(
			(e) => e.type === "tool_execution_update" && e.toolCallId === "call_bash_nested",
		) as Record<string, unknown> | undefined;
		const nestedEnd = wireEvents.find(
			(e) => e.type === "tool_execution_end" && e.toolCallId === "call_bash_nested",
		) as Record<string, unknown> | undefined;

		assert.ok(nestedStart, "Nested bash start event must be emitted");
		assert.equal(
			nestedStart.parentRef,
			undefined,
			"parentRef must be suppressed on nested tools inside codemode to prevent subagent projection",
		);

		assert.ok(nestedUpdate, "Nested bash update event must be emitted");
		assert.equal(nestedUpdate.parentRef, undefined, "parentRef must be suppressed on update");

		assert.ok(nestedEnd, "Nested bash end event must be emitted");
		assert.equal(nestedEnd.parentRef, undefined, "parentRef must be suppressed on end");
	});

	it("DeltaTranslator: defense-in-depth drops parentRef if parent tool was codemode", () => {
		const translator = new DeltaTranslator();
		const ctx = { threadId: "thr_test", cwd: "/tmp" };

		// 1. Start codemode tool
		const codeStartDeltas = translator.translate(
			{
				type: "tool_execution_start",
				toolCallId: "call_code_parent",
				toolName: "codemode",
				args: { code: "// Execute test\nawait tools.read({ path: 'test.txt' })" },
			},
			ctx,
		);
		assert.equal(codeStartDeltas.length, 1);
		assert.equal(codeStartDeltas[0].item?.type, "tool");

		// 2. Child tool arrives with parentRef explicitly pointing to codemode
		const childDeltas = translator.translate(
			{
				type: "tool_execution_start",
				parentRef: "call_code_parent",
				toolCallId: "call_read_child",
				toolName: "read",
				args: { path: "test.txt" },
			},
			ctx,
		);

		assert.equal(childDeltas.length, 1);
		const childDelta = childDeltas[0];
		assert.equal(
			(childDelta.key as Record<string, unknown>).parentRef,
			undefined,
			"DeltaTranslator must drop parentRef when parent tool is codemode",
		);
		assert.equal(
			(childDelta.item as Record<string, unknown>).parentToolCallId,
			undefined,
			"Delta item must not carry parentToolCallId pointing to codemode",
		);
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
		assert.equal(emitted[0].type, "tool_execution_start");
		assert.equal(emitted[0].parentRef, "call_subagent_99", "Subagent child tools must retain parentRef");
	});
});
