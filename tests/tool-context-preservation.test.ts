import test from "node:test";
import assert from "node:assert/strict";
import { adaptExtensionTool } from "../src/runner/tool-adapter.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

test("Issue #21: adaptExtensionTool preserves own property descriptors on context across shallow copy", async () => {
	let executedContext: any = null;

	const mockToolDef: ToolDefinition = {
		name: "test_subagents",
		description: "Mock subagents tool",
		parameters: {},
		async execute(_callId, _args, _signal, _onUpdate, ctx) {
			executedContext = ctx;
			return { content: [{ type: "text", text: "ok" }] };
		},
	};

	const fakeModelRegistry = {
		getAvailable: () => [{ id: "model-1", name: "Model 1" }],
	};

	let getterCalled = false;
	const baseContext = Object.defineProperties({} as any, {
		modelRegistry: {
			get() {
				getterCalled = true;
				return fakeModelRegistry;
			},
			enumerable: true,
			configurable: true,
		},
		cwd: {
			value: "/workspace",
			enumerable: true,
			configurable: true,
			writable: true,
		},
	});

	const adapted = adaptExtensionTool(
		mockToolDef,
		async () => ({ toolCall: {} as any, result: {} as any, isError: false }),
		() => baseContext,
	);

	await (adapted as any).execute({}, { callId: "call_123" });

	assert.ok(executedContext, "Context must be passed to tool execution");
	assert.equal(getterCalled, false, "Getters must not be eagerly evaluated during context adaptation");

	// Direct access
	assert.equal(executedContext.modelRegistry, fakeModelRegistry);
	assert.equal(getterCalled, true);

	// Shallow spread (pi-subagents pattern: { ...ctx, ...managementFields })
	const spread = { ...executedContext, extra: "field" };
	assert.ok(spread.modelRegistry, "spread object must have modelRegistry property");
	assert.equal(spread.modelRegistry.getAvailable().length, 1);
	assert.equal(spread.cwd, "/workspace");
	assert.ok(typeof spread.executeTool === "function", "executeTool must exist on spread");
});
