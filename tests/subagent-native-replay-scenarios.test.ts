import test from "node:test";
import assert from "node:assert/strict";
import { createSubagentExtension } from "../src/runner/subagent.ts";
import type { SubagentPolicyRecord } from "../src/policy/types.ts";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createMockEnv } from "./subagent-fixture-support.ts";

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

		const res2 = await ext.tools![0].execute({ task: "Replayable task", background: true }, env.mockApi, ctx);
		const convId2 = (res2.details as any).conversationId;

		assert.equal(convId1, convId2, "Replay must return existing child conversationId");
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
