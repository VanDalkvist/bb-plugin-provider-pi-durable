import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { adaptExtensionTool } from "../src/runner/tool-adapter.ts";
import { codemodeSection } from "../node_modules/@earendil-works/pi-durable/dist/codemode/describe.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

test("ToolExposure: 'codemode' is included in codemode prompt section (BL-CM-09)", () => {
	const dummyExecutor = async () => ({
		toolCall: { type: "toolCall" as const, id: "1", name: "test", arguments: {} },
		result: { content: [], details: {} },
		isError: false,
	});

	const codemodeTool: ToolDefinition = {
		name: "my_special_script_tool",
		description: "A tool specifically for codemode scripts",
		parameters: Type.Object({ query: Type.String() }),
		exposure: "codemode",
		execute: async () => ({ content: [] }),
	};

	const reg = adaptExtensionTool(codemodeTool, dummyExecutor);

	// In upstream Pi, codemode tools are callable by tools only
	assert.deepEqual(reg.callers, ["tools"]);

	// CRITICAL (BL-CM-09): deferred MUST NOT be true, otherwise codemodeSection() will drop it!
	assert.equal(reg.deferred, undefined, "codemode exposed tools must not have deferred: true");

	// Verify that codemodeSection renders the tool
	const renderedSection = codemodeSection([reg], [], 3000);
	assert.ok(renderedSection, "Expected codemodeSection to produce output");
	assert.ok(
		renderedSection.includes("my_special_script_tool"),
		`Expected rendered codemode section to include my_special_script_tool. Got:\n${renderedSection}`,
	);
});
