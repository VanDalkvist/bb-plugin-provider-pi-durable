import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Harness, MemoryStorage, ToolResultEntry, createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { DefaultResourceLoader, ModelRuntime, type ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { setupExtensionRunner } from "../src/runner/extension-bridge.ts";
import { createNestedToolExecutor } from "../src/runner/extension-mount.ts";
import { adaptExtensionTool, installExtensionTools } from "../src/runner/tool-adapter.ts";
import { DynamicCodemodeNamespaces } from "../src/runner/codemode-namespaces.ts";

const MCP_RESULT_SCHEMA = {
	type: "object",
	properties: {
		content: {
			type: "array",
			items: {
				type: "object",
				properties: { type: { type: "string" }, text: { type: "string" } },
				required: ["type"],
			},
		},
		structuredContent: {},
		isError: { type: "boolean" },
	},
	required: ["content"],
	additionalProperties: true,
};

test("codemode preserves and forwards structuredOutput for MCP tools", { timeout: 15000 }, async () => {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codemode-test-"));
	const env = new NodeExecutionEnv({ cwd: tmpDir });
	const dynamicNs = new DynamicCodemodeNamespaces();

	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(
		createCodemodeExtension({
			sandbox: new CodemodeSandbox(),
			get namespaces() {
				return dynamicNs.getNamespaces();
			},
		}),
	);

	const loader = new DefaultResourceLoader({
		cwd: tmpDir,
		agentDir: path.join(tmpDir, "agent"),
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		disabledBuiltinExtensions: ["mcp"],
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "mcp__test__structured",
					label: "Structured Test Tool",
					description: "Tool that declares outputSchema matching MCP specification",
					parameters: Type.Object({ name: Type.String() }),
					exposure: "codemode",
					namespace: { name: "test", description: "Short server summary" },
					outputSchema: MCP_RESULT_SCHEMA as any,
					execute: async (_id, params) => ({
						content: [{ type: "text", text: `Greeting for ${params.name}` }],
						details: { server: "test", tool: "mcp__test__structured" },
						structuredContent: {
							content: [{ type: "text", text: `Greeting for ${params.name}` }],
							greeting: `Greeting for ${params.name}`,
						},
					}),
				});
			},
		],
	});

	await loader.reload();
	const loaded = loader.getExtensions();
	let runner: ExtensionRunner | undefined;
	const executeToolFn = createNestedToolExecutor(registry, () => runner, () => env);

	const syncTools = () => {
		const current = runner;
		if (!current) return;
		installExtensionTools(
			registry,
			current.getAllRegisteredTools().map((tool) =>
				adaptExtensionTool(
					tool.definition,
					executeToolFn,
					(id) => current.createToolContext(id, undefined),
					() => current,
				),
			),
		);
	};

	runner = await setupExtensionRunner({
		extensions: loaded.extensions,
		runtime: loaded.runtime,
		cwd: tmpDir,
		executeToolFn,
		modelRuntime: await ModelRuntime.create({
			authPath: path.join(tmpDir, "auth.json"),
			modelsPath: null,
			modelsStorePath: path.join(tmpDir, "models.json"),
			allowModelNetwork: false,
			refreshOnCreate: false,
		}),
		getCallableTools: () =>
			registry.snapshot().tools().map(({ tool }) => ({
				name: tool.name,
				description: tool.description ?? "",
				parameters: tool.parameters,
			})),
		onToolsChanged: syncTools,
	});
	syncTools();

	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const storage = new MemoryStorage();
	const harness = await Harness.open(storage, { registry, models, env: () => env }, context);
	const root = await harness.root(context, {
		agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
	});

	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall(
					"codemode",
					{ code: 'const res = await tools.mcp__test__structured({ name: "Bob" }); return res;' },
					{ id: "call-structured" },
				),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);

	const submission = await root.submit({ type: "input", content: "test structured call" }, context);
	await submission.wait(context);

	const entries = await root.entries({}, 1000, undefined, context);
	const toolResult = entries.items
		.filter((item) => ToolResultEntry.is(item))
		.flatMap((item) => item.model ?? [])
		.find((message) => message.role === "toolResult" && message.toolCallId === "call-structured");

	assert.ok(toolResult, "Expected toolResult entry for codemode call");
	assert.equal(toolResult.isError, false, `Tool call failed: ${JSON.stringify(toolResult.content)}`);

	await harness.close(context);
	await storage.close(context);
	await runner?.emit({ type: "session_shutdown", reason: "quit" });
	await env.cleanup(context);
	await fs.rm(tmpDir, { recursive: true, force: true });
});
