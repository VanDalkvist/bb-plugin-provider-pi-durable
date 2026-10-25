import test from "node:test";
import assert from "node:assert/strict";
import {
	profileToPickerValue,
	pickerValueToProfile,
	isModelAvailableInCatalog,
	isThinkingSupportedInCatalog,
	findDefaultCatalogProfile,
} from "../src/ui/profile-codec.ts";
import type { SubagentModelProfile } from "../src/policy/types.ts";

test("profile-codec: bidirectional conversion and none <-> off mapping", () => {
	const profile: SubagentModelProfile = {
		model: { provider: "anthropic", modelId: "claude-3-7-sonnet" },
		thinkingLevel: "off",
	};

	const pickerVal = profileToPickerValue(profile);
	assert.deepEqual(pickerVal, {
		providerId: "pi-durable",
		model: "anthropic/claude-3-7-sonnet",
		reasoningLevel: "none",
	});

	const restored = pickerValueToProfile(pickerVal);
	assert.deepEqual(restored, profile);

	const highProfile: SubagentModelProfile = {
		model: { provider: "anthropic", modelId: "claude-3-7-sonnet" },
		thinkingLevel: "high",
	};
	assert.equal(profileToPickerValue(highProfile).reasoningLevel, "high");
	assert.equal(pickerValueToProfile(profileToPickerValue(highProfile)).thinkingLevel, "high");
});

test("profile-codec: rejects foreign providerId and invalid format", () => {
	assert.throws(
		() => pickerValueToProfile({ providerId: "openai", model: "openai/gpt-4o", reasoningLevel: "none" }),
		/Invalid providerId/,
	);
	assert.throws(
		() => pickerValueToProfile({ providerId: "pi-durable", model: "invalid-format", reasoningLevel: "none" }),
		/Invalid model format/,
	);
});

test("profile-codec: availability and thinking level checks", () => {
	const catalog = [
		{
			id: "anthropic/claude-3-7-sonnet",
			model: "anthropic/claude-3-7-sonnet",
			supportedReasoningEfforts: [
				{ reasoningEffort: "none" },
				{ reasoningEffort: "low" },
				{ reasoningEffort: "high" },
			],
		},
		{
			id: "meta/llama-3",
			model: "meta/llama-3",
			supportedReasoningEfforts: [],
		},
	];

	assert.equal(isModelAvailableInCatalog({ provider: "anthropic", modelId: "claude-3-7-sonnet" }, catalog), true);
	assert.equal(isModelAvailableInCatalog({ provider: "google", modelId: "gemini" }, catalog), false);

	assert.equal(isThinkingSupportedInCatalog({ provider: "anthropic", modelId: "claude-3-7-sonnet" }, "off", catalog), true);
	assert.equal(isThinkingSupportedInCatalog({ provider: "anthropic", modelId: "claude-3-7-sonnet" }, "high", catalog), true);
	assert.equal(isThinkingSupportedInCatalog({ provider: "anthropic", modelId: "claude-3-7-sonnet" }, "medium", catalog), false);

	assert.equal(isThinkingSupportedInCatalog({ provider: "meta", modelId: "llama-3" }, "off", catalog), true);
	assert.equal(isThinkingSupportedInCatalog({ provider: "meta", modelId: "llama-3" }, "high", catalog), false);
});

test("profile-codec: findDefaultCatalogProfile extracts default model", () => {
	const catalog = [
		{
			id: "m1",
			model: "p1/m1",
			isDefault: false,
			defaultReasoningEffort: "low",
		},
		{
			id: "m2",
			model: "p2/m2",
			isDefault: true,
			defaultReasoningEffort: "high",
		},
	];

	const def = findDefaultCatalogProfile(catalog);
	assert.deepEqual(def, {
		model: { provider: "p2", modelId: "m2" },
		thinkingLevel: "high",
	});
});
