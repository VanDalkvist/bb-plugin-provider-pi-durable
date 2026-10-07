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

	it("setupExtensionRunner supports lifecycle startup and shutdown", async () => {
		const { DefaultResourceLoader, getAgentDir, SettingsManager, ModelRuntime } =
			await import("@earendil-works/pi-coding-agent");
		const loader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: getAgentDir(),
			settingsManager: SettingsManager.create(process.cwd()),
		});
		await loader.reload();
		const { extensions, runtime } = loader.getExtensions();

		let shutdownEmitted = false;
		const mockExtension: any = {
			name: "mock-ext",
			handlers: new Map([
				["session_shutdown", [() => { shutdownEmitted = true; }]],
			]),
		};

		const { setupExtensionRunner } = await import("../src/runner/extension-bridge.ts");
		const runner = await setupExtensionRunner({
			extensions: [...extensions, mockExtension],
			runtime,
			cwd: process.cwd(),
			modelRuntime: await ModelRuntime.create(),
			executeToolFn: async () => ({ toolCall: {} as any, result: { content: [], details: {} }, isError: false }),
		});

		assert.ok(runner);
		await runner.emit({ type: "session_shutdown", reason: "shutdown" });
		assert.equal(shutdownEmitted, true, "session_shutdown event must trigger extension handlers");
	});
});
