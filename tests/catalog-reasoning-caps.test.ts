import test from "node:test";
import assert from "node:assert/strict";
import { ModelCatalog } from "../src/host/catalog.ts";

test("ModelCatalog: listModels derives reasoning levels from getSupportedThinkingLevels including minimal", async () => {
	const catalog = new ModelCatalog();
	(catalog as any).runner = {
		exited: false,
		requestOk: async () => ({
			models: [
				{
					provider: "anthropic",
					id: "claude-3-7-sonnet",
					name: "Claude 3.7 Sonnet",
					reasoning: true,
					defaultReasoningEffort: "medium",
					thinkingLevelMap: { off: "off", low: 1000, medium: 2000, high: 4000 },
				},
				{
					provider: "google",
					id: "gemini-2.5-flash",
					name: "Gemini 2.5 Flash",
					reasoning: true,
					thinkingLevelMap: { off: null, minimal: 500, low: 1000, medium: 2000, high: 4000 },
				},
				{
					provider: "meta",
					id: "llama-3-8b",
					name: "Llama 3 8B",
					reasoning: false,
				},
			],
		}),
	};

	const models = await catalog.listModels();
	assert.equal(models.length, 3);

	const sonnet = models.find((m) => m.id === "anthropic/claude-3-7-sonnet")!;
	assert.ok(sonnet);
	const sonnetEfforts = sonnet.supportedReasoningEfforts.map((r) => r.reasoningEffort);
	// off -> none, plus minimal, low, medium, high
	assert.deepEqual(sonnetEfforts, ["none", "minimal", "low", "medium", "high"]);
	assert.equal(sonnet.defaultReasoningEffort, "medium");

	const gemini = models.find((m) => m.id === "google/gemini-2.5-flash")!;
	assert.ok(gemini);
	const geminiEfforts = gemini.supportedReasoningEfforts.map((r) => r.reasoningEffort);
	// off is null, so no "none", minimal is supported
	assert.deepEqual(geminiEfforts, ["minimal", "low", "medium", "high"]);

	const llama = models.find((m) => m.id === "meta/llama-3-8b")!;
	assert.ok(llama);
	assert.deepEqual(llama.supportedReasoningEfforts, []);
	assert.equal(llama.defaultReasoningEffort, "none");
});
