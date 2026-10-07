import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { createRegistry } from "@earendil-works/pi-durable";
import {
	createStandardExtensionFactories,
	adaptExtensionTool,
	installExtensionTools,
} from "../src/runner/extension-bridge.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

describe("Extension Bridge (Cycle 60)", () => {
	it("createStandardExtensionFactories returns 3 built-in factories", () => {
		const factories = createStandardExtensionFactories();
		assert.equal(Array.isArray(factories), true);
		assert.equal(factories.length, 3);
		for (const factory of factories) {
			assert.equal(typeof factory, "function");
		}
	});

	it("adaptExtensionTool maps ToolDefinition to Durable ToolRegistration", async () => {
		let executed = false;
		const mockToolDef: ToolDefinition = {
			name: "mock_search",
			label: "Mock Search",
			description: "Simulates search",
			parameters: Type.Object({ query: Type.String() }),
			execute: async (toolCallId, params) => {
				executed = true;
				return {
					content: [{ type: "text", text: `Found result for: ${(params as any).query}` }],
					details: { matchCount: 1 },
				};
			},
		};

		const durableTool = adaptExtensionTool(mockToolDef, () => {
			throw new Error("No nested executeTool in this test");
		});

		assert.equal(durableTool.name, "mock_search");
		assert.equal(durableTool.description, "Simulates search");
		assert.ok(durableTool.parameters);

		// Execute the adapted tool
		const result = await durableTool.execute(
			{ query: "pi durable" } as any,
			{
				callId: "call_test_123",
				output: () => {},
			} as any,
			{} as any,
		);

		assert.equal(executed, true);
		assert.deepEqual(result.content, [{ type: "text", text: "Found result for: pi durable" }]);
		assert.deepEqual(result.details, { matchCount: 1 });
		assert.equal(result.isError, undefined);
	});

	it("adaptExtensionTool preserves isError and error details", async () => {
		const errorToolDef: ToolDefinition = {
			name: "failing_tool",
			label: "Failing Tool",
			description: "Always fails",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: "Failed to connect to service" }],
				isError: true,
				details: { code: "ECONNREFUSED" },
			}),
		};

		const durableTool = adaptExtensionTool(errorToolDef, () => {
			throw new Error("No nested executeTool");
		});

		const result = await durableTool.execute(
			{} as any,
			{
				callId: "call_err_1",
				output: () => {},
			} as any,
			{} as any,
		);

		assert.equal(result.isError, true);
		assert.deepEqual(result.content, [{ type: "text", text: "Failed to connect to service" }]);
		assert.deepEqual(result.details, { code: "ECONNREFUSED" });
	});

	it("installExtensionTools registers tools into Durable Registry", () => {
		const registry = createRegistry();
		const mockToolDef: ToolDefinition = {
			name: "custom_mcp_tool",
			label: "Custom MCP",
			description: "Tool from MCP server",
			parameters: Type.Object({ cmd: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
		};

		const durableTool = adaptExtensionTool(mockToolDef, () => {
			throw new Error("No nested executeTool");
		});

		installExtensionTools(registry, [durableTool]);

		const installedTools = registry.snapshot().tools();
		const found = installedTools.find((t) => t.tool.name === "custom_mcp_tool");
		assert.ok(found, "custom_mcp_tool must be present in registry snapshot");
		assert.equal(found?.tool.name, "custom_mcp_tool");
		assert.equal(found?.extension.name, "extension-tools");
	});
});
