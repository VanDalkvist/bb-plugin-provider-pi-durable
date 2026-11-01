import test from "node:test";
import assert from "node:assert/strict";
import { buildSpawnArgs } from "../src/host/subthread-spawner.ts";

test("buildSpawnArgs formats clean --model argument without double provider prefix", { timeout: 3000 }, () => {
	const args = {
		parentThreadId: "thr_parent_123",
		title: "Subagent Task",
		task: "Verify security",
		actualModel: { provider: "antigravity", modelId: "antigravity/gemini-3.8-flash" },
		thinkingLevel: "high",
	};
	const cliArgs = buildSpawnArgs(args);
	const modelIndex = cliArgs.indexOf("--model");
	assert.ok(modelIndex !== -1);
	assert.equal(cliArgs[modelIndex + 1], "antigravity/gemini-3.8-flash");
});
