import test from "node:test";
import assert from "node:assert/strict";
import { resolveSubagentModelConfiguration } from "../src/policy/resolver.ts";

test("resolveSubagentModelConfiguration resolves inherit mode when parent has .id instead of .modelId", { timeout: 3000 }, () => {
	const policy = { version: 1 as const, revision: 0, policy: { mode: "inherit" as const } };
	const parentContext = {
		model: { provider: "antigravity", id: "gemini-3.8-flash" } as any,
		thinkingLevel: "high" as const,
	};
	const resolved = resolveSubagentModelConfiguration(policy, parentContext, []);
	assert.equal(resolved.model.provider, "antigravity");
	assert.equal(resolved.model.modelId, "gemini-3.8-flash");
});

test("resolveSubagentModelConfiguration normalizes provider prefix in configured mode", { timeout: 3000 }, () => {
	const availableModels = [
		{ provider: "antigravity", id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", reasoning: true },
	] as any[];
	const policy = {
		version: 1 as const,
		revision: 1,
		policy: {
			mode: "configured" as const,
			configuredProfile: {
				model: { provider: "antigravity", modelId: "antigravity/gemini-3.8-flash" },
				thinkingLevel: "high" as const,
			},
		},
	};
	const resolved = resolveSubagentModelConfiguration(policy, {}, availableModels);
	assert.equal(resolved.model.provider, "antigravity");
	assert.equal(resolved.model.modelId, "gemini-3.8-flash");
});
