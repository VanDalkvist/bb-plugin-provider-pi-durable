import test from "node:test";
import assert from "node:assert/strict";
import { createSubagentExtension } from "../src/runner/subagent.ts";
import { SubagentModelUnavailableError } from "../src/policy/errors.ts";

test("Subagent: rejects nested subagent recursion when conversationId > 1", { timeout: 2000 }, async () => {
	const ext = createSubagentExtension(() => ({
		policy: { mode: "inherit" },
		revision: 1,
		updatedAt: Date.now(),
	}));
	const subagentTool = ext.tools?.[0];
	assert.ok(subagentTool);

	const mockApi: any = {
		conversationId: 2, // child conversation (depth >= 1)
		taskId: 99,
		commit: async (fn: any) => fn({ doc: async () => ({ agents: {} }) }),
		details: async () => {},
	};

	const result = await subagentTool.execute({ task: "Spawn child of child" }, mockApi, {} as any);
	assert.equal(result.isError, true, "Nested recursion must return isError: true");
	assert.equal(result.details?.error, "MAX_DEPTH_EXCEEDED");
});

test("Subagent: rejects with SubagentModelUnavailableError when configured model is unavailable", { timeout: 2000 }, async () => {
	const ext = createSubagentExtension(() => ({
		policy: { mode: "configured", configuredProfile: { model: { provider: "invalid", modelId: "missing-model" } } },
		revision: 1,
		updatedAt: Date.now(),
	}));
	const subagentTool = ext.tools?.[0];
	assert.ok(subagentTool);

	const mockApi: any = {
		conversationId: 1, // root
		taskId: 100,
		commit: async (fn: any) => fn({
			doc: async () => ({ agents: {} }),
		}),
		agent: async () => ({ model: undefined, thinkingLevel: "off" }),
		models: {
			getAvailable: async () => [], // empty models -> resolution must fail fast
		},
		details: async () => {},
	};

	await assert.rejects(
		() => subagentTool.execute({ task: "Run with unavailable model" }, mockApi, {} as any),
		(err: any) => err instanceof SubagentModelUnavailableError || err.code === "SUBAGENT_MODEL_UNAVAILABLE",
	);
});
