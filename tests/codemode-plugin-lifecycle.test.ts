import test from "node:test";
import assert from "node:assert/strict";
import { codemodePlugin } from "../src/runner/plugins/built-in/codemode.ts";
import { subagentsPlugin } from "../src/runner/plugins/built-in/subagents.ts";
import { createCodingRegistry } from "../src/runner/harness-setup.ts";
import { createHarnessSettings } from "../src/runner/harness-setup.ts";
import { createRegistry } from "@earendil-works/pi-durable";

const defaultPolicy = () => ({ version: 1 as const, revision: 0, policy: { mode: "inherit" as const } });

test("codemodePlugin has lifecycle teardown closing sandbox", { timeout: 10000 }, async () => {
	assert.equal(typeof codemodePlugin.teardown, "function", "codemodePlugin must implement teardown");

	const registry = createRegistry();
	codemodePlugin.register({
		cwd: "/test",
		registry,
	});

	// Calling teardown should gracefully close activeSandbox
	await assert.doesNotReject(async () => {
		await codemodePlugin.teardown?.();
	});
});

test("subagentsPlugin has lifecycle teardown", { timeout: 5000 }, async () => {
	assert.equal(typeof subagentsPlugin.teardown, "function", "subagentsPlugin must implement teardown");
	await assert.doesNotReject(async () => {
		await subagentsPlugin.teardown?.();
	});
});

test("createCodingRegistry returns pluginRegistry and enables teardownAll", { timeout: 10000 }, async () => {
	const settings = createHarnessSettings();
	const codingRegistry = await createCodingRegistry(
		settings,
		"/test",
		defaultPolicy,
	);

	assert.ok(codingRegistry.pluginRegistry, "Expected pluginRegistry attached to codingRegistry");
	let customTeardownCalled = false;
	codingRegistry.pluginRegistry.register({
		id: "custom-test-plugin",
		name: "Custom Test",
		category: "custom",
		version: "1.0.0",
		register() {},
		teardown() {
			customTeardownCalled = true;
		},
	});

	await codingRegistry.pluginRegistry.teardownAll();
	assert.equal(customTeardownCalled, true, "Expected custom plugin teardown to be called by teardownAll");
});
