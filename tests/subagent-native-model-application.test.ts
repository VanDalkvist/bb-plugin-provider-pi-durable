import test from "node:test";
import assert from "node:assert/strict";
import { buildTechnicalWorkerRole } from "../src/runner/subagent-role.ts";
import { createSubagentExtension } from "../src/runner/subagent.ts";
import { SubagentModelUnavailableError, SubagentPolicyInvalidError } from "../src/policy/errors.ts";
import type { SubagentPolicyRecord } from "../src/policy/types.ts";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createMockEnv } from "./subagent-fixture-support.ts";

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

		const childAgent = env.childAgents["conv_child_99"];
		assert.equal(childAgent.model?.modelId, "mod-high");
		assert.equal(childAgent.thinkingLevel, "high");
		assert.equal(childAgent.instructions, buildTechnicalWorkerRole());

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
