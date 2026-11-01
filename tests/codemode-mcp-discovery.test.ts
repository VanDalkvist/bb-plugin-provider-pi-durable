import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import {
	adaptExtensionTool,
	installExtensionTools,
	setupExtensionRunner,
} from "../src/runner/extension-bridge.ts";
import {
	ModelRuntime,
	type Extension,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createRegistry } from "@earendil-works/pi-durable";

test("Parity: codemode discovers and calls registered MCP tools via searchTools and describeNamespace", async () => {
	const registry = createRegistry();
	const modelRuntime = await ModelRuntime.create();

	let runner: any;
	const executeToolFn = async (callerId: string, name: string, args: unknown) => {
		const target = runner.getAllRegisteredTools().find((t: any) => t.definition.name === name);
		if (!target) {
			return {
				toolCall: { type: "toolCall", id: "call_err", name, arguments: args },
				result: { content: [{ type: "text", text: `Tool ${name} not found` }] },
				isError: true,
			};
		}
		const ctx = runner.createToolContext(callerId, undefined);
		const res = await target.definition.execute(callerId, args, undefined, () => {}, ctx);
		return {
			toolCall: { type: "toolCall", id: "call_nested", name, arguments: args },
			result: { content: res.content, details: res.details },
			isError: !!res.isError,
		};
	};

	const syncToolsToRegistry = () => {
		const createToolContext = (callId: string) => runner.createToolContext(callId, undefined);
		const adapted = runner.getAllRegisteredTools().map((t: any) =>
			adaptExtensionTool(t.definition, executeToolFn, createToolContext, () => runner),
		);
		installExtensionTools(registry, adapted);
	};

	// A mock MCP tool with namespace
	const mockMcpToolDef: ToolDefinition = {
		name: "mcp__test__greet",
		description: "Greet a user by name",
		parameters: Type.Object({ name: Type.String() }),
		exposure: "codemode",
		namespace: { name: "mcp__test", description: "Mock test service" },
		execute: async (_callId, params: any) => ({
			content: [{ type: "text", text: `Hello, ${params.name}!` }],
		}),
	};

	const mockMcpExt: Extension = {
		name: "mock-mcp-service",
		path: "inline:mock-mcp-service",
		tools: new Map([["mcp__test__greet", { definition: mockMcpToolDef, sourceInfo: { path: "mock" } as any }]]),
		handlers: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
		commands: new Map(),
	} as any;

	const { createCodemodeExtension } = await import("@earendil-works/pi-coding-agent");
	const codemodeFactory = createCodemodeExtension({ mode: "on" });
	const codemodeExt: Extension = {
		name: "codemode",
		path: "inline:codemode",
		tools: new Map(),
		handlers: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
		commands: new Map(),
	} as any;
	codemodeFactory({
		registerTool: (def: any) => {
			codemodeExt.tools.set(def.name, { definition: def, sourceInfo: { path: "codemode" } as any });
		},
		registerCommand: () => {},
		registerShortcut: () => {},
		registerToolRenderer: () => {},
		on: () => {},
		appendEntry: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		getActiveTools: () => ["codemode"],
		getAllTools: () => runner?.getAllRegisteredTools().map((t: any) => ({
			name: t.definition.name,
			description: t.definition.description,
			parameters: t.definition.parameters,
			promptGuidelines: t.definition.promptGuidelines,
			exposure: t.definition.exposure,
			namespace: t.definition.namespace,
			annotations: t.definition.annotations,
			sourceInfo: t.sourceInfo,
		})) ?? [],
		getSettings: () => ({}),
		setActiveTools: () => {},
		refreshTools: () => syncToolsToRegistry(),
	} as any);

	runner = await setupExtensionRunner({
		extensions: [codemodeExt, mockMcpExt],
		runtime: {
			pendingProviderRegistrations: [],
			pendingNativeProviderRegistrations: [],
			pendingVirtualModelRegistrations: [],
			flagValues: new Map(),
			mcpServers: { list: () => [], setChangeListener: () => {} },
			invalidate: () => {},
		} as any,
		cwd: process.cwd(),
		modelRuntime,
		executeToolFn,
		getCallableTools: () => (runner ? runner.getAllRegisteredTools().map((t: any) => ({
			name: t.definition.name,
			description: t.definition.description,
			parameters: t.definition.parameters,
			outputSchema: t.definition.outputSchema,
		})) : []),
		onToolsChanged: syncToolsToRegistry,
	});

	syncToolsToRegistry();

	const codemodeTool = runner.getAllRegisteredTools().find((t: any) => t.definition.name === "codemode");
	assert.ok(codemodeTool, "codemode tool must be registered");

	const ctx = runner.createToolContext("test_call_id", undefined);

	// 1. Test searchTools with namespace
	const searchResult = await codemodeTool.definition.execute(
		"test_call_id",
		{ code: "const res = await searchTools(\"greet\", { namespace: \"mcp__test\" }); text(JSON.stringify(res.map(x => x.name)));" },
		undefined,
		() => {},
		ctx,
	);
	const searchOutput = searchResult.content?.map((c: any) => c.text).join("");
	assert.ok(searchOutput?.includes("mcp__test__greet"), `searchTools should find mcp__test__greet: ${searchOutput}`);

	// 2. Test describeNamespace
	const descResult = await codemodeTool.definition.execute(
		"test_call_id",
		{ code: "const desc = await describeNamespace(\"mcp__test\"); text(JSON.stringify(desc));" },
		undefined,
		() => {},
		ctx,
	);
	const descOutput = descResult.content?.map((c: any) => c.text).join("");
	assert.ok(descOutput?.includes("mcp__test__greet"), `describeNamespace should include tools: ${descOutput}`);

	// 3. Test calling tools.mcp__test__greet
	const callResult = await codemodeTool.definition.execute(
		"test_call_id",
		{ code: "const res = await tools.mcp__test__greet({ name: 'Vanya' }); text(String(res));" },
		undefined,
		() => {},
		ctx,
	);
	const callOutput = callResult.content?.map((c: any) => c.text).join("");
	assert.ok(callOutput?.includes("Hello, Vanya!"), `tools.mcp__test__greet should return result: ${callOutput}`);

	await runner.emit({ type: "session_shutdown", reason: "quit" });
});
