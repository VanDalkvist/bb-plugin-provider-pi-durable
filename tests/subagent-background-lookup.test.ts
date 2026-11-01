import test from "node:test";
import assert from "node:assert/strict";
import { createSubagentExtension } from "../src/runner/subagent.ts";
import { SubagentsDoc } from "../src/runner/subagent-docs.ts";
import { Anchor } from "../src/runner/subagent-delivery.ts";

test("Subagent: background conversation lookup reuses existing anchor conversation on replay", async () => {
	const ext = createSubagentExtension(() => ({
		policy: { mode: "inherit" },
		revision: 1,
		updatedAt: Date.now(),
	}));
	const subagentTool = ext.tools?.[0];
	assert.ok(subagentTool);

	const docStore: any = {
		agents: {},
	};

	let conversationsCreated = 0;
	let anchorTasksCreated = 0;

	const mockTx: any = {
		doc: async (docDef: any) => {
			if (docDef === SubagentsDoc) return docStore;
			return {};
		},
		scanConversations: async (query: any) => {
			// If queried by anchor task ID 501, return existing conversation 2
			if (query.ownerTaskId === 501) {
				return { items: [{ id: 2 }] };
			}
			return { items: [] };
		},
		createTask: async (taskDef: any) => {
			if (taskDef === Anchor) {
				anchorTasksCreated++;
				return 501;
			}
			return 601;
		},
		createConversation: async () => {
			conversationsCreated++;
			return { id: 2 };
		},
	};

	const mockApi: any = {
		conversationId: 1,
		taskId: 10,
		commit: async (fn: any) => fn(mockTx),
		agent: async () => ({ model: { provider: "mock", modelId: "mock" }, thinkingLevel: "off" }),
		details: async () => {},
	};

	// 1. First execution creates conversation 2 and anchor 501
	const res1 = await subagentTool.execute({ task: "Background task" }, mockApi, {} as any);
	assert.equal(res1.details?.conversationId, 2);
	assert.equal(conversationsCreated, 1);
	assert.equal(anchorTasksCreated, 1);
	assert.ok(docStore.agents["subagent:10"]);
	assert.equal(docStore.agents["subagent:10"].anchorTaskId, 501);

	// 2. Second execution (replay) must find conversation 2 and not create duplicates
	const res2 = await subagentTool.execute({ task: "Background task" }, mockApi, {} as any);
	assert.equal(res2.details?.conversationId, 2);
	assert.equal(conversationsCreated, 1, "Must not create a second conversation");
	assert.equal(anchorTasksCreated, 1, "Must not create a second anchor task");
});
