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

export interface CodemodeHarness {
	execCode(code: string, callId?: string): Promise<{ text: string; isError: boolean }>;
	cleanup(): Promise<void>;
}

/** Real native API/transactions/nested tool tasks; only the model's answers are scripted. */
export async function createCodemodeTestHarness(): Promise<CodemodeHarness> {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codemode-coverage-"));
	const env = new NodeExecutionEnv({ cwd: tmpDir });
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(createCodemodeExtension({
		sandbox: new CodemodeSandbox(),
		namespaces: [{ name: "mcp__test", prefix: "mcp__test__", description: "Mock test service" }],
	}));
	const loader = new DefaultResourceLoader({
		cwd: tmpDir, agentDir: path.join(tmpDir, "agent"),
		noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		disabledBuiltinExtensions: ["mcp"],
		extensionFactories: [(pi) => {
			pi.registerTool({
				name: "mcp__test__greet", label: "Greet", description: "Greet a user by name",
				parameters: Type.Object({ name: Type.String() }), exposure: "codemode",
				namespace: { name: "mcp__test", description: "Mock test service" },
				execute: async (_id, params) => ({ content: [{ type: "text", text: `Hello, ${params.name}!` }], details: {} }),
			});
		}],
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	if (loaded.errors.length) throw new Error("FIXTURE_EXTENSION_LOAD_FAILED");
	let runner: ExtensionRunner | undefined;
	const executeToolFn = createNestedToolExecutor(registry, () => runner, () => env);
	const syncTools = () => {
		if (!runner) throw new Error("FIXTURE_RUNNER_NOT_READY");
		const current = runner;
		installExtensionTools(registry, current.getAllRegisteredTools().map((tool) =>
			adaptExtensionTool(tool.definition, executeToolFn, (id) => current.createToolContext(id, undefined), () => current)));
	};
	runner = await setupExtensionRunner({
		extensions: loaded.extensions, runtime: loaded.runtime, cwd: tmpDir, executeToolFn,
		modelRuntime: await ModelRuntime.create({
			authPath: path.join(tmpDir, "auth.json"), modelsPath: null,
			modelsStorePath: path.join(tmpDir, "models.json"), allowModelNetwork: false, refreshOnCreate: false,
		}),
		getCallableTools: () => registry.snapshot().tools().map(({ tool }) => ({
			name: tool.name, description: tool.description ?? "", parameters: tool.parameters,
		})),
		onToolsChanged: syncTools,
	});
	syncTools();
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const storage = new MemoryStorage();
	const harness = await Harness.open(storage, { registry, models, env: () => env }, context);
	const root = await harness.root(context, { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } } });
	let counter = 0;
	return {
		async execCode(code, callId) {
			const id = callId ?? `fixture-code-${++counter}`;
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("codemode", { code }, { id })], { stopReason: "toolUse" }),
				fauxAssistantMessage("fixture-complete"),
			]);
			const settled = await (await root.submit({ type: "input", content: "execute fixture" }, context)).wait(context);
			if (settled.status !== "done") throw new Error("FIXTURE_SUBMISSION_UNSETTLED");
			const entries = await root.entries({}, 1000, undefined, context);
			const result = entries.items.filter((item) => ToolResultEntry.is(item)).flatMap((item) => item.model ?? [])
				.find((message) => message.role === "toolResult" && message.toolCallId === id);
			if (!result || result.role !== "toolResult") throw new Error("FIXTURE_TOOL_RESULT_MISSING");
			return { text: result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n"), isError: result.isError };
		},
		async cleanup() {
			await harness.close(context);
			await storage.close(context);
			await runner?.emit({ type: "session_shutdown", reason: "quit" });
			await env.cleanup(context);
			await fs.rm(tmpDir, { recursive: true, force: true });
		},
	};
}
