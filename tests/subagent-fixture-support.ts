import { AgentDoc } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { SubagentsDoc } from "../src/runner/subagent-docs.ts";

export function createMockEnv(root: any, models: any, taskId = "task_exec_1") {
	const docStore: any = { agents: {} };
	const childAgents: Record<string, any> = {};
	let createConversationCalled = false;
	let reportedDetails: any;

	const mockTx: any = {
		doc: async (token: any, cid: any) => {
			if (token === SubagentsDoc) return docStore;
			if (token === AgentDoc) {
				childAgents[cid] ??= {};
				return childAgents[cid];
			}
			return {};
		},
		scanConversations: async () => ({ items: [] }),
		createConversation: async () => {
			createConversationCalled = true;
			return { id: "conv_child_99" };
		},
		createTask: async (_t: any, _inp: any) => "task_reporter_1",
	};

	const mockApi: any = {
		taskId,
		conversationId: root.id,
		agent: async () => root.agent(ctx),
		models,
		commit: async (fn: any) => fn(mockTx),
		details: async (d: any) => { reportedDetails = d; },
	};

	return {
		mockApi,
		mockTx,
		docStore,
		childAgents,
		getDetails: () => reportedDetails,
		wasConversationCreated: () => createConversationCalled,
	};
}
