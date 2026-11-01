import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { adaptExtensionTool } from "../src/runner/tool-adapter.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

test("adaptExtensionTool maps exposure correctly (BL-CM-04)", () => {
	const dummyExecutor = async () => ({
		toolCall: { type: "toolCall" as const, id: "1", name: "test", arguments: {} },
		result: { content: [], details: {} },
		isError: false,
	});

	// Test 1: exposure 'codemode' -> callers: ['tools'], deferred: true
	const codemodeTool: ToolDefinition = {
		name: "test_codemode",
		description: "Codemode tool",
		parameters: Type.Object({}),
		exposure: "codemode",
		execute: async () => ({ content: [] }),
	};
	const reg1 = adaptExtensionTool(codemodeTool, dummyExecutor);
	assert.deepEqual(reg1.callers, ["tools"]);
	assert.equal(reg1.deferred, true, "codemode tool must have deferred: true");

	// Test 2: exposure 'deferred' -> callers: ['model', 'tools'], deferred: true
	const deferredTool: ToolDefinition = {
		name: "test_deferred",
		description: "Deferred tool",
		parameters: Type.Object({}),
		exposure: "deferred",
		execute: async () => ({ content: [] }),
	};
	const reg2 = adaptExtensionTool(deferredTool, dummyExecutor);
	assert.deepEqual(reg2.callers, ["model", "tools"]);
	assert.equal(reg2.deferred, true, "deferred tool must have deferred: true");

	// Test 3: exposure 'model-only' -> callers: ['model'], deferred: false
	const modelTool: ToolDefinition = {
		name: "test_model_only",
		description: "Model tool",
		parameters: Type.Object({}),
		exposure: "model-only",
		execute: async () => ({ content: [] }),
	};
	const reg3 = adaptExtensionTool(modelTool, dummyExecutor);
	assert.deepEqual(reg3.callers, ["model"]);
	assert.equal(reg3.deferred, undefined);
});

test("adaptExtensionTool forwards abortSignal to toolDef.execute (BL-CM-08)", async () => {
	const dummyExecutor = async () => ({
		toolCall: { type: "toolCall" as const, id: "1", name: "test", arguments: {} },
		result: { content: [], details: {} },
		isError: false,
	});

	let receivedSignal: AbortSignal | undefined;
	const abortTool: ToolDefinition = {
		name: "test_abort",
		description: "Abort test tool",
		parameters: Type.Object({}),
		execute: async (_callId, _args, signal) => {
			receivedSignal = signal;
			return { content: [] };
		},
	};

	const reg = adaptExtensionTool(abortTool, dummyExecutor);
	const controller = new AbortController();
	const mockApi = {
		callId: "call-1",
		output: () => {},
	};

	await reg.execute({}, mockApi as any, { abortSignal: controller.signal } as any);
	assert.ok(receivedSignal, "Expected abortSignal to be forwarded to toolDef.execute");
	assert.equal(receivedSignal, controller.signal, "Forwarded signal must match context.abortSignal");
});
