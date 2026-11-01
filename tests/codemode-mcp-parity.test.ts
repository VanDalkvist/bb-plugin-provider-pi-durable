import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import {
	adaptExtensionTool,
	createStandardExtensionFactories,
	installExtensionTools,
	setupExtensionRunner,
} from "../src/runner/extension-bridge.ts";
import { createNestedToolExecutor } from "../src/runner/extension-mount.ts";
import {
	DefaultResourceLoader,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	type Extension,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createRegistry } from "@earendil-works/pi-durable";

test("Parity: adaptExtensionTool maps exposure to durable callers", () => {
	const dummyDef = (name: string, exposure?: any): ToolDefinition => ({
		name,
		description: name,
		parameters: Type.Object({}),
		exposure,
		execute: async () => ({ content: [] }),
	});

	const tDirect = adaptExtensionTool(dummyDef("t_direct", "direct"), async () => ({} as any));
	assert.deepEqual(tDirect.callers, ["model", "tools"]);

	const tCodemode = adaptExtensionTool(dummyDef("t_codemode", "codemode"), async () => ({} as any));
	assert.deepEqual(tCodemode.callers, ["tools"]);

	const tDeferred = adaptExtensionTool(dummyDef("t_deferred", "deferred"), async () => ({} as any));
	assert.deepStrictEqual(tDeferred.callers, ["model", "tools"]);
	assert.strictEqual(tDeferred.deferred, true);

	const tCodemodeDeferred = adaptExtensionTool(dummyDef("t_codemode_deferred", "codemode-deferred"), async () => ({} as any));
	assert.deepEqual(tCodemodeDeferred.callers, ["tools"]);

	const tModelOnly = adaptExtensionTool(dummyDef("t_model_only", "model-only"), async () => ({} as any));
	assert.deepEqual(tModelOnly.callers, ["model"]);

	const tHidden = adaptExtensionTool(dummyDef("t_hidden", "hidden"), async () => ({} as any));
	assert.deepEqual(tHidden.callers, []);
});

test("Parity: setupExtensionRunner binds setActiveTools and comprehensive contextActions without crash", async () => {
	let activatedTools: string[] = ["read", "write"];

	const mockMcpExt: Extension = {
		name: "mcp-test",
		path: "inline:test-mcp",
		tools: new Map(),
		handlers: new Map([
			[
				"session_start",
				[
					async (_event: any, ctx: any) => {
						// This reproduces what MCP extension does: it checks signal and activates codemode
						assert.equal(ctx.signal, undefined);
						ctx.setActiveTools(["read", "write", "codemode"]);

						// Contract completeness: these methods must exist on ctx/actions without crashing
						assert.doesNotThrow(() => {
							ctx.sendMessage({ customType: "test", content: "hello" });
							ctx.sendUserMessage("user test");
							ctx.appendEntry("custom_test", { foo: "bar" });
							ctx.setSessionName("session-test-name");
							assert.equal(ctx.getSessionName(), "session-test-name");
							ctx.setLabel("entry-1", "important");
						});
					},
				],
			],
			[
				"tool_call",
				[
					async (event: any, ctx: any) => {
						// Accessing ctx.signal must not throw
						const sig = ctx.signal;
						assert.equal(sig, undefined);
					},
				],
			],
		]),
		flags: new Map(),
		shortcuts: new Map(),
		commands: new Map(),
	} as any;

	let onActiveChangedCalled = false;
	const runner = await setupExtensionRunner({
		extensions: [mockMcpExt],
		runtime: {
			pendingProviderRegistrations: [],
			pendingNativeProviderRegistrations: [],
			pendingVirtualModelRegistrations: [],
			flagValues: new Map(),
			mcpServers: { list: () => [], setChangeListener: () => {} },
			invalidate: () => {},
		} as any,
		cwd: process.cwd(),
		modelRuntime: await ModelRuntime.create(),
		executeToolFn: async () => ({ toolCall: {} as any, result: { content: [], details: {} }, isError: false }),
		onActiveToolsChanged: (tools) => {
			onActiveChangedCalled = true;
			assert.deepEqual(tools, ["a", "b"]);
		},
	});

	// Check that runner runtime has setActiveTools and it updates active tools and notifies
	runner.runtime.setActiveTools(["a", "b"]);
	assert.deepEqual(runner.getActiveTools(), ["a", "b"]);
	assert.equal(onActiveChangedCalled, true, "setActiveTools must notify onActiveToolsChanged");

	// Contract completeness: check session and messaging runtime actions
	assert.doesNotThrow(() => {
		runner.runtime.sendMessage({ customType: "test", content: "hello" });
		runner.runtime.sendUserMessage("user test");
		runner.runtime.appendEntry("custom_test", { foo: "bar" });
		runner.runtime.setSessionName("session-test-name");
		assert.equal(runner.runtime.getSessionName(), "session-test-name");
		runner.runtime.setLabel("entry-1", "important");
	});

	// Emitting tool_call checks ctx.signal
	await runner.emitToolCall({
		type: "tool_call",
		toolName: "test_tool",
		toolCallId: "c1",
		input: {},
	});

	await runner.emit({ type: "session_shutdown", reason: "quit" });
});
