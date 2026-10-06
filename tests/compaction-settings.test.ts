import test from "node:test";
import assert from "node:assert/strict";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createHarnessSettings } from "../src/runner/harness-setup.ts";

test("createHarnessSettings resolves model-specific compaction override for 300k max window", () => {
	const settingsManager = SettingsManager.inMemory({
		compaction: {
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 30000,
			modelOverrides: {
				"antigravity/gemini-3.8-flash": {
					reserveTokens: 748576,
					keepRecentTokens: 30000,
				},
			},
		},
		defaultProvider: "antigravity",
		defaultModel: "gemini-3.8-flash",
	});

	const getActiveModel = () => ({ provider: "antigravity", modelId: "gemini-3.8-flash" });
	const getModelContextWindow = () => 1048576;

	const settings = createHarnessSettings(settingsManager, getActiveModel, getModelContextWindow);
	const compaction = settings.compaction;

	assert.equal(compaction?.enabled, true);
	assert.equal(compaction?.reserveTokens, 748576);
	assert.equal(compaction?.keepRecentTokens, 30000);
	// Effective threshold: 1,048,576 - 748,576 = 300,000
	assert.equal(1048576 - (compaction?.reserveTokens ?? 0), 300000);
});

test("createHarnessSettings falls back to automatic 300k window cap when model has >300k cw without explicit override", () => {
	const settingsManager = SettingsManager.inMemory({
		compaction: {
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 30000,
		},
	});

	const getActiveModel = () => ({ provider: "antigravity", modelId: "custom-1m-model" });
	const getModelContextWindow = () => 1048576;

	const settings = createHarnessSettings(settingsManager, getActiveModel, getModelContextWindow);
	const compaction = settings.compaction;

	assert.equal(compaction?.enabled, true);
	// Automatically capped: 1,048,576 - 300,000 = 748,576
	assert.equal(compaction?.reserveTokens, 748576);
	assert.equal(1048576 - (compaction?.reserveTokens ?? 0), 300000);
});

test("createHarnessSettings preserves standard reserveTokens when model context window <= 300k", () => {
	const settingsManager = SettingsManager.inMemory({
		compaction: {
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 30000,
		},
	});

	const getActiveModel = () => ({ provider: "antigravity", modelId: "claude-sonnet-4-6" });
	const getModelContextWindow = () => 200000;

	const settings = createHarnessSettings(settingsManager, getActiveModel, getModelContextWindow);
	const compaction = settings.compaction;

	assert.equal(compaction?.enabled, true);
	assert.equal(compaction?.reserveTokens, 16384);
});
