import test from "node:test";
import assert from "node:assert/strict";
import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { createSubagentExtension } from "../src/runner/subagent.ts";
import { SubagentsDoc } from "../src/runner/subagent-docs.ts";
import { Anchor, DefaultCourier, DefaultReporter, BACKGROUND } from "../src/runner/subagent-delivery.ts";
import type { SubagentPolicyRecord } from "../src/policy/types.ts";

function createTestHarness(models: ReturnType<typeof createModels>, policy: SubagentPolicyRecord) {
	const registry = createRegistry();
	const ext = createSubagentExtension(() => policy);
	registry.install(ext);
	registry.install(Anchor);
	registry.install(DefaultCourier);
	registry.install(DefaultReporter);
	return { registry, ext };
}

const defaultPolicy: SubagentPolicyRecord = {
	version: 1,
	revision: 0,
	policy: { mode: "inherit" },
};

test("foreground subagent: record is valid strict JSON, omits anchorTaskId, and executes to result", async () => {
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("Synchronous child answer")]);

	const models = createModels();
	models.setProvider(faux.provider);

	const { registry, ext } = createTestHarness(models, defaultPolicy);
	const storage = new MemoryStorage();
	const harness = await Harness.open(storage, { models, registry }, ctx);

	try {
		const root = await harness.root(ctx, {
			agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id }, thinkingLevel: "off" },
		});

		let parentTaskId: any;
		await root.commit(async (tx) => {
			parentTaskId = await tx.createTask(Anchor, null, BACKGROUND);
		}, ctx);

		const tool = ext.tools[0];
		const mockApi: any = {
			taskId: parentTaskId,
			conversationId: root.id,
			agent: async () => root.agent(ctx),
			models,
			commit: (fn: any) => root.commit(fn, ctx),
			details: async () => {},
			conversation: async (id: any) => harness.conversation(id),
		};

		const result = await tool.execute({ task: "Perform sync math", background: false }, mockApi, ctx);

		assert.equal(result.output[0].text, "Synchronous child answer");

		const state = await harness.snapshot(SubagentsDoc, root.id, ctx);
		const key = `subagent:${parentTaskId}`;
		const rec = state.agents[key];

		assert.ok(rec, "Record must exist in SubagentsDoc");
		assert.equal(rec.background, false);
		assert.equal("anchorTaskId" in rec, false, "anchorTaskId must be omitted when no anchor exists");
		assert.equal(rec.anchorTaskId, undefined);
		assert.equal(rec.settled, true);
		assert.equal(rec.report, "Synchronous child answer");

		// Strict JSON copy boundary check (Chord copyJson invariant)
		assert.doesNotThrow(() => copyJson(rec), "Record must satisfy strict JSON serialization");
	} finally {
		await harness.close(ctx);
	}
});

test("background subagent: preserves anchorTaskId and reporter under strict JSON", async () => {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);

	const { registry, ext } = createTestHarness(models, defaultPolicy);
	const storage = new MemoryStorage();
	const harness = await Harness.open(storage, { models, registry }, ctx);

	try {
		const root = await harness.root(ctx, {
			agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id }, thinkingLevel: "off" },
		});

		let parentTaskId: any;
		await root.commit(async (tx) => {
			parentTaskId = await tx.createTask(Anchor, null, BACKGROUND);
		}, ctx);

		const tool = ext.tools[0];
		const mockApi: any = {
			taskId: parentTaskId,
			conversationId: root.id,
			agent: async () => root.agent(ctx),
			models,
			commit: (fn: any) => root.commit(fn, ctx),
			details: async () => {},
			conversation: async (id: any) => harness.conversation(id),
		};

		const result = await tool.execute({ task: "Perform background task", background: true }, mockApi, ctx);

		assert.ok(result.output[0].text.includes("Subagent spawned in background"));

		const state = await harness.snapshot(SubagentsDoc, root.id, ctx);
		const key = `subagent:${parentTaskId}`;
		const rec = state.agents[key];

		assert.ok(rec, "Record must exist in SubagentsDoc");
		assert.equal(rec.background, true);
		assert.ok(rec.anchorTaskId !== undefined, "anchorTaskId must be present in background mode");
		assert.ok(rec.reporter !== undefined, "reporter task must be present in background mode");

		// Strict JSON copy boundary check
		assert.doesNotThrow(() => copyJson(rec), "Background record must satisfy strict JSON serialization");
	} finally {
		await harness.close(ctx);
	}
});
