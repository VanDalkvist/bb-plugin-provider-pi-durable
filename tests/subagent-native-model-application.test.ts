import test from "node:test";
import assert from "node:assert/strict";
import { buildTechnicalWorkerRole } from "../src/runner/subagent-role.ts";
import { createSubagentExtension } from "../src/runner/subagent.ts";
import { SubagentsDoc } from "../src/runner/subagent-docs.ts";
import { SubagentModelUnavailableError, SubagentPolicyInvalidError } from "../src/policy/errors.ts";
import type { SubagentPolicyRecord } from "../src/policy/types.ts";
import { AgentDoc, Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";

function createMockEnv(root: any, models: any, taskId = "task_exec_1") {
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

test("buildTechnicalWorkerRole: returns static neutral technical envelope without task interpolation or git bans", () => {
	const role = buildTechnicalWorkerRole();
	assert.ok(role.includes("isolated worker subagent"));
	assert.ok(role.includes("Execute the assigned task thoroughly"));
	assert.equal(role.includes("git archaeology"), false, "Must not ban git archaeology");
	assert.equal(role.includes("Audit authentication routes"), false, "Task must not be interpolated into role envelope");
});

test("native subagent execution: configured mode resolves model, configures child, leaves parent untouched", async () => {
	const faux = fauxProvider({
		provider: "test-prov",
		models: [
			{ id: "mod-high", name: "Model High", reasoning: true },
			{ id: "mod-root", name: "Root Model", reasoning: true },
		],
	});
	const models = createModels();
	models.setProvider(faux.provider);

	let currentPolicy: SubagentPolicyRecord = {
		version: 1,
		revision: 1,
		policy: {
			mode: "configured",
			configuredProfile: {
				model: { provider: "test-prov", modelId: "mod-high" },
				thinkingLevel: "high",
			},
		},
	};

	const subagentExt = createSubagentExtension(() => currentPolicy);
	const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, ctx);
	try {
		const root = await harness.root(ctx, {
			agent: { model: { provider: "test-prov", modelId: "mod-root" }, thinkingLevel: "low" },
		});

		const env = createMockEnv(root, models, "task_cfg_1");
		const tool = subagentExt.tools![0];
		const result = await tool.execute({ task: "Run benchmark", background: true }, env.mockApi, ctx);

		assert.ok(result.output[0].text.includes("Subagent spawned in background"));
		const details = env.getDetails();
		assert.equal(details.actualModel.modelId, "mod-high");
		assert.equal(details.thinkingLevel, "high");
		assert.equal(details.source, "user_configured");
		assert.equal(details.policyRevision, 1);

		// Verify child conversation was configured with resolved model
		const childAgent = env.childAgents["conv_child_99"];
		assert.equal(childAgent.model?.modelId, "mod-high");
		assert.equal(childAgent.thinkingLevel, "high");
		assert.equal(childAgent.instructions, buildTechnicalWorkerRole());

		// Verify parent root agent is completely untouched
		const parentAgent = await root.agent(ctx);
		assert.equal(parentAgent.model?.modelId, "mod-root");
		assert.equal(parentAgent.thinkingLevel, "low");
	} finally {
		await harness.close(ctx);
	}
});

test("native subagent execution: inherit mode maps parent and avoids credential probe", async () => {
	const faux = fauxProvider({
		provider: "test-prov",
		models: [{ id: "mod-parent", name: "Parent Model", reasoning: true }],
	});
	const models = createModels();
	models.setProvider(faux.provider);

	const policy: SubagentPolicyRecord = {
		version: 1,
		revision: 0,
		policy: { mode: "inherit" },
	};

	const subagentExt = createSubagentExtension(() => policy);
	const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, ctx);
	try {
		const root = await harness.root(ctx, {
			agent: { model: { provider: "test-prov", modelId: "mod-parent" }, thinkingLevel: "medium" },
		});

		const env = createMockEnv(root, models, "task_inh_1");
		const tool = subagentExt.tools![0];
		await tool.execute({ task: "Audit config", background: true }, env.mockApi, ctx);

		const details = env.getDetails();
		assert.equal(details.actualModel.modelId, "mod-parent");
		assert.equal(details.thinkingLevel, "medium");
		assert.equal(details.source, "parent_inherited");
		assert.equal(details.policyRevision, 0);

		const childAgent = env.childAgents["conv_child_99"];
		assert.equal(childAgent.model?.modelId, "mod-parent");
		assert.equal(childAgent.thinkingLevel, "medium");
	} finally {
		await harness.close(ctx);
	}
});

test("native subagent execution: fails fast before child creation when model unavailable or thinking unsupported", async () => {
	const faux = fauxProvider({
		provider: "test-prov",
		models: [{ id: "mod-no-reasoning", name: "No Reasoning Model", reasoning: false }],
	});
	const models = createModels();
	models.setProvider(faux.provider);

	// 1. Missing model
	const missingPolicy: SubagentPolicyRecord = {
		version: 1,
		revision: 1,
		policy: {
			mode: "configured",
			configuredProfile: { model: { provider: "unknown", modelId: "none" }, thinkingLevel: "low" },
		},
	};
	const extMissing = createSubagentExtension(() => missingPolicy);
	const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, ctx);
	try {
		const root = await harness.root(ctx, { agent: { model: { provider: "test-prov", modelId: "mod-no-reasoning" } } });
		const envMissing = createMockEnv(root, models, "task_fail_1");

		await assert.rejects(
			() => extMissing.tools![0].execute({ task: "T", background: true }, envMissing.mockApi, ctx),
			(err: any) => err instanceof SubagentModelUnavailableError || err.code === "SUBAGENT_MODEL_UNAVAILABLE",
		);
		assert.equal(envMissing.wasConversationCreated(), false, "Must not create conversation on unavailable model");

		// 2. Unsupported thinking level
		const badThinkingPolicy: SubagentPolicyRecord = {
			version: 1,
			revision: 2,
			policy: {
				mode: "configured",
				configuredProfile: { model: { provider: "test-prov", modelId: "mod-no-reasoning" }, thinkingLevel: "high" },
			},
		};
		const extThinking = createSubagentExtension(() => badThinkingPolicy);
		const envThinking = createMockEnv(root, models, "task_fail_2");
		await assert.rejects(
			() => extThinking.tools![0].execute({ task: "T", background: true }, envThinking.mockApi, ctx),
			(err: any) => err instanceof SubagentPolicyInvalidError || err.code === "SUBAGENT_POLICY_INVALID",
		);
		assert.equal(envThinking.wasConversationCreated(), false, "Must not create conversation on unsupported thinking");
	} finally {
		await harness.close(ctx);
	}
});

test("native subagent execution: replay safety reuses existing child and reporter without reconfiguration", async () => {
	const faux = fauxProvider({
		provider: "test-prov",
		models: [{ id: "mod-1", name: "Model 1", reasoning: true }],
	});
	const models = createModels();
	models.setProvider(faux.provider);

	const policy: SubagentPolicyRecord = {
		version: 1,
		revision: 1,
		policy: {
			mode: "configured",
			configuredProfile: { model: { provider: "test-prov", modelId: "mod-1" }, thinkingLevel: "low" },
		},
	};
	const ext = createSubagentExtension(() => policy);
	const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, ctx);
	try {
		const root = await harness.root(ctx, { agent: { model: { provider: "test-prov", modelId: "mod-1" } } });
		const env = createMockEnv(root, models, "task_replay_1");

		const res1 = await ext.tools![0].execute({ task: "Replayable task", background: true }, env.mockApi, ctx);
		const convId1 = (res1.details as any).conversationId;

		// Second invocation with identical taskId represents replay
		const res2 = await ext.tools![0].execute({ task: "Replayable task", background: true }, env.mockApi, ctx);
		const convId2 = (res2.details as any).conversationId;

		assert.equal(convId1, convId2, "Replay must return existing child conversationId");

		// Verify SubagentsDoc has exactly 1 entry for this key
		const entries = Object.keys(env.docStore.agents);
		assert.equal(entries.length, 1);
	} finally {
		await harness.close(ctx);
	}
});

test("policy changes between 2 child admissions affect new child only", async () => {
	const faux = fauxProvider({
		provider: "test-prov",
		models: [
			{ id: "mod-v1", name: "V1", reasoning: true },
			{ id: "mod-v2", name: "V2", reasoning: true },
		],
	});
	const models = createModels();
	models.setProvider(faux.provider);

	let activePolicy: SubagentPolicyRecord = {
		version: 1,
		revision: 1,
		policy: {
			mode: "configured",
			configuredProfile: { model: { provider: "test-prov", modelId: "mod-v1" }, thinkingLevel: "low" },
		},
	};

	const ext = createSubagentExtension(() => activePolicy);
	const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, ctx);
	try {
		const root = await harness.root(ctx, { agent: { model: { provider: "test-prov", modelId: "mod-v1" } } });

		const env = createMockEnv(root, models, "task_seq_1");
		let childCounter = 1;
		env.mockTx.createConversation = async () => ({ id: `conv_child_${childCounter++}` });

		const res1 = await ext.tools![0].execute({ task: "First task", background: true }, env.mockApi, ctx);
		const child1Id = (res1.details as any).conversationId;

		// Now change policy to V2 and update taskId for child 2
		activePolicy = {
			version: 1,
			revision: 2,
			policy: {
				mode: "configured",
				configuredProfile: { model: { provider: "test-prov", modelId: "mod-v2" }, thinkingLevel: "high" },
			},
		};

		env.mockApi.taskId = "task_seq_2";
		const res2 = await ext.tools![0].execute({ task: "Second task", background: true }, env.mockApi, ctx);
		const child2Id = (res2.details as any).conversationId;

		const child1Agent = env.childAgents[child1Id];
		assert.equal(child1Agent.model?.modelId, "mod-v1");
		assert.equal(child1Agent.thinkingLevel, "low");

		const child2Agent = env.childAgents[child2Id];
		assert.equal(child2Agent.model?.modelId, "mod-v2");
		assert.equal(child2Agent.thinkingLevel, "high");
	} finally {
		await harness.close(ctx);
	}
});

