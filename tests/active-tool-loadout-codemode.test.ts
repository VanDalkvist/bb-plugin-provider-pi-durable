import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	MemoryStorage,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { Anchor, BACKGROUND } from "../src/runner/subagent-delivery.ts";

const context = BACKGROUND_CONTEXT;

describe("Codemode & Subagent Boundary Isolation (Cycle 98 - AP-011, AP-026)", () => {
	it("restricting modelTools to codemode allows codemode to call other tools via agent.callable", async () => {
		let readExecutedWith: unknown = null;

		const readTool = defineTool({
			name: "read",
			description: "Read a file from disk",
			parameters: Type.Object({ path: Type.String() }),
			callers: ["model", "tools"],
			execute: async (args) => {
				readExecutedWith = args.path;
				return { output: [{ type: "text", text: "file content: hello" }] };
			},
		});

		const filesExt = defineExtension({
			name: "files",
			tools: [readTool],
		});

		const codemodeExt = createCodemodeExtension({
			sandbox: new CodemodeSandbox(),
			models: false,
		});

		const registry = createRegistry();
		registry.install(filesExt);
		registry.install(codemodeExt);

		const faux = fauxProvider();
		faux.setResponses([fauxAssistantMessage("ok")]);
		const models = createModels();
		models.setProvider(faux.provider);

		const harness = await Harness.open(
			new MemoryStorage(),
			{ models, registry, settings: { extensions: [filesExt, codemodeExt] } },
			context,
		);

		const root = await harness.root(context, {
			agent: {
				model: { provider: "faux", modelId: "faux-1" },
				modelTools: [{ name: "codemode" }] as any, // tool-diet: ONLY codemode offered to model
			},
		});

		const agent = await root.agent(context);

		// 1. Model directly is ONLY offered codemode
		assert.equal(agent.tools.length, 1);
		assert.equal(agent.tools[0].name, "codemode");

		// 2. agent.callable STILL contains read (callable from scripts)
		const callableNames = agent.callable.map((t) => t.name);
		assert.ok(callableNames.includes("read"));

		// 3. Executing codemode script calling tools.read() succeeds!
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", { code: 'return await tools.read({ path: "test.txt" });' }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Done!"),
		]);

		const submission = await root.submit({ type: "input", content: "Run read tool inside codemode" }, context);
		const settled = await submission.wait(context);

		assert.equal(settled.status, "done");
		assert.equal(readExecutedWith, "test.txt");

		await harness.close(context);
	});

	it("child subagent conversation inherits modelTools from parent without corrupting parent", async () => {
		const dummyToolA = defineTool({
			name: "tool_a",
			description: "Tool A",
			parameters: Type.Object({}),
			execute: async () => ({ output: [] }),
		});

		const dummyToolB = defineTool({
			name: "tool_b",
			description: "Tool B",
			parameters: Type.Object({}),
			execute: async () => ({ output: [] }),
		});

		const dummyExt = defineExtension({
			name: "dummy",
			tools: [dummyToolA, dummyToolB],
		});

		const registry = createRegistry();
		registry.install(dummyExt);
		registry.install(Anchor);

		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);

		const harness = await Harness.open(
			new MemoryStorage(),
			{ models, registry, settings: { extensions: [dummyExt, Anchor] } },
			context,
		);

		const root = await harness.root(context, {
			agent: {
				model: { provider: "faux", modelId: "faux-1" },
				modelTools: [{ name: "tool_a" }] as any, // Parent restricted to tool_a
			},
		});

		// Create a task-owned child conversation
		const child = await harness.commitWith(async (tx) => {
			const task = await tx.createTask(Anchor, null, { conversationId: root.id, ...BACKGROUND });
			const childConv = await tx.createConversation({ ownership: { kind: "task", taskId: task } });
			return childConv.id;
		}, context);

		const childHandle = (await harness.conversation(child, context))!;
		const childAgent = await childHandle.agent(context);

		// Child inherited parent's tool_a
		assert.deepEqual(childAgent.tools.map((t) => t.name), ["tool_a"]);

		// Now reconfigure child to tool_b
		await childHandle.configure({ modelTools: [{ name: "tool_b" }] as any }, context);

		const updatedChildAgent = await childHandle.agent(context);
		assert.deepEqual(updatedChildAgent.tools.map((t) => t.name), ["tool_b"]);

		// Parent STILL has tool_a (isolated!)
		const parentAgent = await root.agent(context);
		assert.deepEqual(parentAgent.tools.map((t) => t.name), ["tool_a"]);

		await harness.close(context);
	});
});
