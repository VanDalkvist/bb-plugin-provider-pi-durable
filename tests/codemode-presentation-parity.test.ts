import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { resolveToolPresentation } from "../src/host/tool-presentations.ts";
import {
	buildToolItemShape,
	translateToolStart,
	translateToolEnd,
} from "../src/host/tool-delta-translator.ts";

describe("Codemode built-in provider presentation parity", () => {
	const args = { code: "// Inspect logs\nawait tools.bash({ command: 'tail -n 20 app.log' })" };

	it("uses the default BB tool presentation rather than custom code labels", () => {
		const shape = buildToolItemShape("codemode", args, "/tmp");
		assert.equal(resolveToolPresentation("codemode", shape, args), undefined);
	});

	it("opens a generic codemode card with its original source arguments", () => {
		const { shape, delta } = translateToolStart({
			type: "tool_execution_start",
			toolCallId: "call_code_1",
			toolName: "codemode",
			args,
		}, "/tmp");

		assert.deepEqual(shape, { type: "tool", tool: "codemode", server: "pi", args });
		assert.equal(delta.kind, "item.open");
		assert.deepEqual(delta.item, shape);
		assert.equal(Object.hasOwn(delta, "presentation"), false);
		assert.equal(delta.key.parentRef, undefined);
		assert.equal(threadDeltaSchema.safeParse(delta).success, true);
	});

	for (const isError of [false, true]) {
		it(`closes a ${isError ? "failed" : "successful"} codemode card without overriding BB's renderer`, () => {
			const result = isError
				? "Script failed\nScript error:\nfetch failed"
				: "Script completed\nWall time 0.1 seconds\nOutput:\nOK";
			const delta = translateToolEnd({
				type: "tool_execution_end",
				toolCallId: "call_code_1",
				toolName: "codemode",
				result,
				isError,
			}, buildToolItemShape("codemode", args, "/tmp"), "/tmp");

			assert.equal(delta.kind, "item.close");
			assert.equal(delta.status, isError ? "failed" : "completed");
			assert.equal(delta.resultText, result);
			assert.equal(delta.item.type, "tool");
			assert.equal(delta.item.tool, "codemode");
			assert.deepEqual(delta.item.args, args);
			assert.equal(Object.hasOwn(delta, "presentation"), false);
			assert.equal(delta.key.parentRef, undefined);
			if (isError) assert.equal(delta.item.error, result);
			assert.equal(threadDeltaSchema.safeParse(delta).success, true);
		});
	}

	it("retains the existing subagent presentation", () => {
		const { delta } = translateToolStart({
			type: "tool_execution_start",
			toolCallId: "call_agent_1",
			toolName: "subagent",
			args: { task: "Review the patch" },
		}, "/tmp");
		assert.equal(delta.item.type, "delegation");
		assert.deepEqual(delta.presentation, {
			label: { pending: "Starting background subagent", completed: "Started background subagent" },
			icon: { glyph: "Bot" },
			title: "Review the patch",
		});
	});
});
