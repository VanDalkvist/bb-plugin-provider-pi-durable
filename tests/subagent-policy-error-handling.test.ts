import test from "node:test";
import assert from "node:assert/strict";
import { createSubagentExtension } from "../src/runner/subagent.ts";

test("Subagent: rejects nested subagent recursion when conversationId !== 1", async () => {
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

test("Subagent: returns isError: true with actionable explanation when model policy fails", async () => {
	const ext = createSubagentExtension(() => ({
		policy: { mode: "configured", model: { provider: "invalid", modelId: "missing-model" } },
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
			getAvailable: async () => [], // empty models -> resolution will throw
		},
		details: async () => {},
	};

	const result = await subagentTool.execute({ task: "Run with unavailable model" }, mockApi, {} as any);
	assert.equal(result.isError, true, "Model resolution error must return isError: true");
	assert.match(result.output?.[0]?.text ?? "", /Subagent creation rejected by model policy/);
});
