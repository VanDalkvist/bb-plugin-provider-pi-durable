import test from "node:test";
import assert from "node:assert/strict";
import { Anchor, BACKGROUND } from "../src/runner/subagent-delivery.ts";
import { Subagent } from "./fixtures/subagent-courier-delivery-support.ts";

test("subagent tool: background mode creates conversation under background Anchor task", async () => {
	const tool = Subagent.tools[0];
	const docStore: any = { agents: {} };
	const createdTasks: any[] = [];
	let createdConversationOwnership: any;

	const mockApi: any = {
		taskId: "task_tool_foreground",
		conversationId: "conv_root",
		agent: async () => ({ model: { provider: "test-prov", modelId: "test-mod" }, thinkingLevel: "off" }),
		models: { getAvailable: async () => [] },
		commit: async (fn: any) => {
			const mockTx: any = {
				scanConversations: async () => ({ items: [] }),
				createTask: async (def: any, input: any, ownership: any) => {
					const id = def === Anchor ? "task_anchor_1" : "task_reporter_1";
					createdTasks.push({ id, def, input, ownership });
					return id;
				},
				createConversation: async (options: any) => {
					createdConversationOwnership = options.ownership;
					return { id: "conv_child_background" };
				},
				doc: async () => docStore,
			};
			return fn(mockTx);
		},
		details: async () => {},
	};

	const res = await tool.execute(
		{ task: "Execute background code analysis", background: true },
		mockApi,
		{} as any,
	);

	assert.ok(res.output[0].text.includes("Subagent spawned in background"));

	// 1. Anchor task must be created as background task
	const anchorTask = createdTasks.find((t) => t.def === Anchor);
	assert.ok(anchorTask, "Anchor task must be created");
	assert.deepEqual(anchorTask.ownership, BACKGROUND, "Anchor must have BACKGROUND ownership");
	assert.equal(anchorTask.id, "task_anchor_1");

	// 2. Child conversation must be owned by the Anchor task, NOT by the foreground tool task
	assert.ok(createdConversationOwnership, "createConversation must be called with ownership");
	assert.equal(createdConversationOwnership.kind, "task");
	assert.equal(
		createdConversationOwnership.taskId,
		"task_anchor_1",
		"Child conversation must be owned by Anchor task, NOT foreground tool task",
	);
	assert.notEqual(
		createdConversationOwnership.taskId,
		"task_tool_foreground",
		"Foreground tool task must NEVER own child conversation (prevents completing block)",
	);

	// 3. SubagentsDoc must record both logical owner and anchor
	const agentRecord = docStore.agents["subagent:task_tool_foreground"];
	assert.ok(agentRecord, "Agent record must exist in SubagentsDoc");
	assert.equal(agentRecord.ownerTaskId, "task_tool_foreground", "Logical owner is caller tool");
	assert.equal(agentRecord.anchorTaskId, "task_anchor_1", "Anchor task must be recorded");
});

test("subagent tool: foreground mode retains direct caller task ownership", async () => {
	const tool = Subagent.tools[0];
	const docStore: any = { agents: {} };
	let createdConversationOwnership: any;

	const mockApi: any = {
		taskId: "task_tool_sync",
		conversationId: "conv_root",
		agent: async () => ({ model: { provider: "test-prov", modelId: "test-mod" }, thinkingLevel: "off" }),
		models: { getAvailable: async () => [] },
		commit: async (fn: any) => {
			const mockTx: any = {
				scanConversations: async () => ({ items: [] }),
				createTask: async () => "task_any",
				createConversation: async (options: any) => {
					createdConversationOwnership = options.ownership;
					return { id: "conv_child_sync" };
				},
				doc: async () => docStore,
				entry: async () => ({
					model: [{ role: "assistant", content: [{ type: "text", text: "Done" }] }],
				}),
			};
			return fn(mockTx);
		},
		details: async () => {},
		conversation: async () => ({
			submit: async () => ({
				wait: async () => ({ status: "done", type: "input", answer: "ans_sync" }),
			}),
		}),
	};

	await tool.execute(
		{ task: "Execute sync foreground task", background: false },
		mockApi,
		{} as any,
	);

	// In synchronous foreground mode, caller task intentionally owns child conversation
	assert.equal(createdConversationOwnership.kind, "task");
	assert.equal(createdConversationOwnership.taskId, "task_tool_sync");
});
