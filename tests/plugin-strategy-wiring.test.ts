import test from "node:test";
import assert from "node:assert/strict";
import { createCodingRegistry } from "../src/runner/harness-setup.ts";
import type { DurablePlugin } from "../src/runner/plugins/types.ts";
import { defineExtension } from "@earendil-works/pi-durable";

test("GoF Strategy: createCodingRegistry initializes plugins via DurablePluginRegistry", { timeout: 3000 }, async () => {
	let customPluginInitialized = false;

	const customPlugin: DurablePlugin = {
		id: "custom-test-plugin",
		name: "Custom Test Plugin",
		category: "custom",
		version: "1.0.0",
		register(ctx) {
			customPluginInitialized = true;
			ctx.registry?.install(defineExtension({ name: "custom-test-ext" }));
		},
	};

	const mockSettingsManager: any = {
		getDefaultProvider: () => "test",
		getDefaultModel: () => "model",
		getDefaultThinkingLevel: () => "off",
		getGlobalSettings: () => ({}),
		getProjectSettings: () => ({}),
	};

	const registry = await createCodingRegistry(
		mockSettingsManager,
		process.cwd(),
		() => ({ policy: { mode: "inherit" }, revision: 1, updatedAt: Date.now() }),
		undefined,
		undefined,
		[customPlugin],
	);

	assert.ok(registry, "Registry must be created");
	assert.equal(customPluginInitialized, true, "Custom plugin must be initialized via DurablePluginRegistry");

	const snapshot = registry.snapshot();
	const installedNames = snapshot.installed().map((e) => e.name);
	assert.ok(installedNames.includes("custom-test-ext"), "Custom extension must be installed in registry");
	assert.ok(installedNames.includes("subagent"), "Built-in subagents extension must be installed");
});
