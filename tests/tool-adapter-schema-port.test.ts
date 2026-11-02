import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { adaptExtensionTool } from "../src/runner/tool-adapter.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

test("tool-adapter: uses SchemaPort for runtime argument coercion and validation", async () => {
	let executedArgs: unknown = null;

	const dummyTool: ToolDefinition = {
		name: "test_coerced_tool",
		description: "Test tool coercion",
		parameters: Type.Object({
			port: Type.Number(),
		}),
		execute: async (_callId, args) => {
			executedArgs = args;
			return { content: [] };
		},
	};

	const reg = adaptExtensionTool(dummyTool, async () => ({
		toolCall: { type: "toolCall", id: "1", name: "test_coerced_tool", arguments: {} },
		result: { content: [], details: {} },
		isError: false,
	}));

	assert.ok(reg);
	assert.equal(reg.name, "test_coerced_tool");

	// Test execution with stringified number - SchemaPort should coerce "8080" to 8080
	await reg.execute({ port: "8080" }, { callId: "c1" } as any, {} as any);
	assert.deepEqual(executedArgs, { port: 8080 });
});
