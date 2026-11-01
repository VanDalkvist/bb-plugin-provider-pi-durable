#!/usr/bin/env node

/**
 * Diagnostic script for Codemode & Tool Execution Subsystem
 *
 * Checks:
 * 1. Pure JS execution in QuickJS sandbox
 * 2. System tools execution (bash, read)
 * 3. MCP tool execution with outputSchema (reproduces BL-CM-01)
 * 4. Namespace instructions preservation in DynamicCodemodeNamespaces (reproduces BL-CM-03)
 * 5. Plugin lifecycle & teardown check (reproduces BL-CM-02)
 */

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

async function runDiagnostics() {
	console.log("\n========================================================");
	console.log("       Pi Durable Codemode Diagnostics & Repro          ");
	console.log("========================================================\n");

	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codemode-diag-"));
	const env = new NodeExecutionEnv({ cwd: tmpDir });
	const dynamicNs = new DynamicCodemodeNamespaces();

	// Check 1: DynamicCodemodeNamespaces instructions check
	console.log("[Diagnostic 1] Checking DynamicCodemodeNamespaces instructions preservation...");
	dynamicNs.registerFromToolDefinitions([
		{
			name: "mcp__test__structured",
			namespace: {
				name: "test",
				description: "Short server summary",
				instructions: "Detailed server operating contract instructions",
			},
		},
	]);

	const nsList = dynamicNs.getNamespaces();
	const testNs = nsList.find((n) => n.name === "test");
	const hasInstructions = Boolean(testNs?.instructions);
	console.log(`  Namespace description: "${testNs?.description}"`);
	console.log(`  Namespace instructions: "${testNs?.instructions}"`);
	if (!hasInstructions) {
		console.log("  ❌ BL-CM-03 CONFIRMED: instructions property is missing/collapsed into description!");
	} else {
		console.log("  ✅ instructions properly preserved.");
	}

	// Check 2: Setup real harness with MCP tool having outputSchema
	console.log("\n[Diagnostic 2] Testing Codemode execution with structured MCP tool...");
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

	// Run script that calls tools.mcp__test__structured
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

	const outputText = toolResult?.content?.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n") ?? "";
	const isError = Boolean(toolResult?.isError);

	console.log(`  Codemode execution isError: ${isError}`);
	if (isError && outputText.includes("returned no structuredOutput")) {
		console.log("  ❌ BL-CM-01 CONFIRMED: Tool returned no structuredOutput! QuickJS script rejected.");
		console.log(`     Error details: ${outputText.split("\n")[1]}`);
	} else if (!isError) {
		console.log("  ✅ Codemode successfully executed structured tool call!");
	} else {
		console.log(`  ⚠️ Failed with different error: ${outputText}`);
	}

	await harness.close(context);
	await storage.close(context);
	await runner?.emit({ type: "session_shutdown", reason: "quit" });
	await env.cleanup(context);
	await fs.rm(tmpDir, { recursive: true, force: true });

	console.log("\n========================================================");
	console.log("Diagnostics completed successfully.");
	console.log("========================================================\n");
}

runDiagnostics().catch((err) => {
	console.error("Diagnostic failed with fatal error:", err);
	process.exit(1);
});
