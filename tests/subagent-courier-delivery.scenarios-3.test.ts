import test from "node:test";
import assert from "node:assert/strict";
import { SubagentsDoc } from "../src/runner/subagent-docs.ts";
import {
	Anchor,
	BACKGROUND,
	courierFor,
	reporterFor,
} from "../src/runner/subagent-delivery.ts";
import { createSubagentExtension } from "../src/runner/subagent.ts";
import { Subagent } from "./fixtures/subagent-courier-delivery-support.ts";

test("Subagent tool: registers record in SubagentsDoc, uses friendly name, and does not double-submit on background execution", async () => {
	const tool = Subagent.tools[0];
	const docStore: any = { agents: {} };
	let createdTasks: any[] = [];
	let childConversationSubmitted = false;

	const mockApi: any = {
		taskId: "task_parent_exec",
		conversationId: "conv_parent_exec",
		agent: async () => ({ model: { provider: "test-prov", modelId: "test-mod" }, thinkingLevel: "off" }),
		models: { getAvailable: async () => [] },
		commit: async (fn: any) => {
			const mockTx: any = {
				scanConversations: async () => ({ items: [] }),
				createConversation: async () => ({ id: "conv_child_live" }),
				doc: async () => docStore,
				createTask: async (def: any, input: any, ownership: any) => {
					createdTasks.push({ def, input, ownership });
					return "task_reporter_gen";
				},
			};
			return fn(mockTx);
		},
		details: async () => {},
		conversation: async () => {
			childConversationSubmitted = true;
			return {
				submit: async () => ({
					wait: async () => ({ status: "done", type: "input", answer: "a1" }),
				}),
			};
		},
	};

	const res = await tool.execute(
		{ task: "Background integration job", background: true },
		mockApi,
		{} as any,
	);

	assert.ok(res.output[0].text.includes("Subagent spawned in background"));
	assert.equal(childConversationSubmitted, false, "Must NOT call api.conversation or child.submit in background mode");
	assert.equal(createdTasks.length, 1);
	assert.equal(createdTasks[0].input.task, "Background integration job");
	assert.equal(createdTasks[0].input.conversationId, "conv_child_live");
	assert.equal(docStore.agents["subagent:task_parent_exec"].reporter, "task_reporter_gen");
	assert.equal(docStore.agents["subagent:task_parent_exec"].task, "Background integration job");
	assert.equal(
		docStore.agents["subagent:task_parent_exec"].name,
		"Background integration job · worker",
		"Subagent record name must use nativeChildTitle friendly name",
	);
});

test("Subagent tool: foreground execution directly submits and waits for child completion", async () => {
	const tool = Subagent.tools[0];
	const docStore: any = { agents: {} };
	let submitCalled = false;
	let waitCalled = false;

	const mockApi: any = {
		taskId: "task_parent_sync",
		conversationId: "conv_parent_sync",
		agent: async () => ({ model: { provider: "test-prov", modelId: "test-mod" }, thinkingLevel: "off" }),
		models: { getAvailable: async () => [] },
		commit: async (fn: any) => {
			const mockTx: any = {
				scanConversations: async () => ({ items: [] }),
				createConversation: async () => ({ id: "conv_child_sync" }),
				doc: async () => docStore,
				entry: async () => ({
					model: [{ role: "assistant", content: [{ type: "text", text: "Sync result OK" }] }],
				}),
			};
			return fn(mockTx);
		},
		details: async () => {},
		conversation: async () => ({
			submit: async (req: any) => {
				submitCalled = true;
				assert.equal(req.content, "Run synchronous computation");
				return {
					wait: async () => {
						waitCalled = true;
						return { status: "done", type: "input", answer: "ans_sync" };
					},
				};
			},
		}),
	};

	const res = await tool.execute(
		{ task: "Run synchronous computation", background: false },
		mockApi,
		{} as any,
	);

	assert.equal(submitCalled, true, "Foreground subagent must call handle.submit");
	assert.equal(waitCalled, true, "Foreground subagent must wait for completion");
	assert.equal(res.output[0].text, "Sync result OK");
	assert.equal(docStore.agents["subagent:task_parent_sync"].settled, true);
	assert.equal(docStore.agents["subagent:task_parent_sync"].report, "Sync result OK");
});
