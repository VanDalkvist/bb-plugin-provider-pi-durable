import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DurablePluginRegistry } from "../src/runner/plugins/registry.ts";
import { DurablePluginError } from "../src/runner/errors.ts";
import type { DurablePlugin, DurablePluginContext } from "../src/runner/plugins/types.ts";
import { codingToolsPlugin } from "../src/runner/plugins/built-in/coding-tools.ts";
import { codemodePlugin } from "../src/runner/plugins/built-in/codemode.ts";
import { subagentsPlugin } from "../src/runner/plugins/built-in/subagents.ts";
import { loadExternalPlugins } from "../src/runner/plugins/external/loader.ts";

test("DurablePluginRegistry registers, gets, and lists plugins by category", () => {
	const registry = new DurablePluginRegistry();

	const builtinPlugin: DurablePlugin = {
		id: "test-builtin",
		name: "Test Builtin",
		category: "built-in",
		version: "1.0.0",
		register: () => {},
	};

	const externalPlugin: DurablePlugin = {
		id: "test-external",
		name: "Test External",
		category: "external",
		version: "0.1.0",
		register: () => {},
	};

	registry.register(builtinPlugin);
	registry.register(externalPlugin);

	assert.equal(registry.get("test-builtin"), builtinPlugin);
	assert.equal(registry.get("test-external"), externalPlugin);
	assert.equal(registry.get("non-existent"), undefined);

	assert.deepEqual(registry.list(), [builtinPlugin, externalPlugin]);
	assert.deepEqual(registry.list("built-in"), [builtinPlugin]);
	assert.deepEqual(registry.list("external"), [externalPlugin]);
});

test("duplicate plugin id throws DurablePluginError with code PLUGIN_ERROR", () => {
	const registry = new DurablePluginRegistry();

	const plugin1: DurablePlugin = {
		id: "dup-plugin",
		name: "Plugin 1",
		category: "built-in",
		version: "1.0.0",
		register: () => {},
	};

	const plugin2: DurablePlugin = {
		id: "dup-plugin",
		name: "Plugin 2",
		category: "external",
		version: "2.0.0",
		register: () => {},
	};

	registry.register(plugin1);

	assert.throws(
		() => registry.register(plugin2),
		(err: unknown) => {
			assert.ok(err instanceof DurablePluginError);
			assert.equal(err.code, "PLUGIN_ERROR");
			assert.equal(err.pluginId, "dup-plugin");
			return true;
		},
	);
});

test("initAll(ctx) calls plugin register(ctx) and throws DurablePluginError on error", async () => {
	const registry = new DurablePluginRegistry();
	const callLog: string[] = [];

	const ctx: DurablePluginContext = {
		cwd: "/test/cwd",
		storageDir: "/test/storage",
		customData: 123,
	};

	const pluginA: DurablePlugin = {
		id: "plugin-a",
		name: "Plugin A",
		category: "built-in",
		version: "1.0.0",
		register: (c) => {
			assert.equal(c.cwd, "/test/cwd");
			callLog.push("a");
		},
	};

	const pluginB: DurablePlugin = {
		id: "plugin-b",
		name: "Plugin B",
		category: "external",
		version: "1.0.0",
		register: async (c) => {
			assert.equal(c.storageDir, "/test/storage");
			callLog.push("b");
		},
	};

	registry.register(pluginA);
	registry.register(pluginB);

	await registry.initAll(ctx);
	assert.deepEqual(callLog, ["a", "b"]);

	const failingRegistry = new DurablePluginRegistry();
	const failingPlugin: DurablePlugin = {
		id: "failing-plugin",
		name: "Failing Plugin",
		category: "built-in",
		version: "1.0.0",
		register: () => {
			throw new Error("Init crash");
		},
	};

	failingRegistry.register(failingPlugin);

	await assert.rejects(
		async () => failingRegistry.initAll(ctx),
		(err: unknown) => {
			assert.ok(err instanceof DurablePluginError);
			assert.equal(err.code, "PLUGIN_ERROR");
			assert.equal(err.pluginId, "failing-plugin");
			assert.ok(err.message.includes("Init crash"));
			return true;
		},
	);
});

test("teardownAll() calls plugin teardown() gracefully", async () => {
	const registry = new DurablePluginRegistry();
	const tornDown: string[] = [];

	const plugin1: DurablePlugin = {
		id: "p1",
		name: "P1",
		category: "built-in",
		version: "1.0.0",
		register: () => {},
		teardown: () => {
			tornDown.push("p1");
		},
	};

	const pluginFails: DurablePlugin = {
		id: "p-fail",
		name: "PFail",
		category: "external",
		version: "1.0.0",
		register: () => {},
		teardown: () => {
			tornDown.push("p-fail");
			throw new Error("Teardown boom");
		},
	};

	const plugin2: DurablePlugin = {
		id: "p2",
		name: "P2",
		category: "built-in",
		version: "1.0.0",
		register: () => {},
		teardown: async () => {
			tornDown.push("p2");
		},
	};

	registry.register(plugin1);
	registry.register(pluginFails);
	registry.register(plugin2);

	// Should not throw even when p-fail throws
	await registry.teardownAll();

	// All teardowns were called
	assert.ok(tornDown.includes("p1"));
	assert.ok(tornDown.includes("p-fail"));
	assert.ok(tornDown.includes("p2"));
	assert.equal(tornDown.length, 3);
});

test("external loader loads mock plugin from directory", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-plugins-test-"));

	try {
		const mockPluginDir = join(tempDir, "mock-plugin");
		mkdirSync(mockPluginDir, { recursive: true });

		writeFileSync(
			join(mockPluginDir, "plugin.json"),
			JSON.stringify({
				id: "mock-ext",
				name: "Mock External Plugin",
				version: "0.2.1",
			}),
			"utf8",
		);

		const emptyDir = join(tempDir, "empty-dir");
		mkdirSync(emptyDir, { recursive: true });

		const standaloneJson = join(tempDir, "standalone.json");
		writeFileSync(
			standaloneJson,
			JSON.stringify({
				id: "standalone-ext",
				name: "Standalone Plugin",
				version: "1.1.0",
			}),
			"utf8",
		);

		const plugins = await loadExternalPlugins(tempDir);

		assert.equal(plugins.length, 2);

		const mockExt = plugins.find((p) => p.id === "mock-ext");
		assert.ok(mockExt);
		assert.equal(mockExt.name, "Mock External Plugin");
		assert.equal(mockExt.version, "0.2.1");
		assert.equal(mockExt.category, "external");
		assert.equal(typeof mockExt.register, "function");

		const standaloneExt = plugins.find((p) => p.id === "standalone-ext");
		assert.ok(standaloneExt);
		assert.equal(standaloneExt.name, "Standalone Plugin");
		assert.equal(standaloneExt.version, "1.1.0");
		assert.equal(standaloneExt.category, "external");

		// Non-existent directory returns empty array
		const emptyPlugins = await loadExternalPlugins(join(tempDir, "non-existent"));
		assert.deepEqual(emptyPlugins, []);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("built-in plugins conform to DurablePlugin interface and register into registry", async () => {
	assert.equal(codingToolsPlugin.id, "coding-tools");
	assert.equal(codingToolsPlugin.category, "built-in");
	assert.equal(typeof codingToolsPlugin.register, "function");

	assert.equal(codemodePlugin.id, "codemode");
	assert.equal(codemodePlugin.category, "built-in");
	assert.equal(typeof codemodePlugin.register, "function");

	assert.equal(subagentsPlugin.id, "subagents");
	assert.equal(subagentsPlugin.category, "built-in");
	assert.equal(typeof subagentsPlugin.register, "function");

	const installed: unknown[] = [];
	const mockRegistry = {
		install: (item: unknown) => {
			installed.push(item);
		},
	};

	const reg = new DurablePluginRegistry();
	reg.register(codingToolsPlugin);
	reg.register(codemodePlugin);
	reg.register(subagentsPlugin);

	assert.equal(reg.list("built-in").length, 3);

	await reg.initAll({
		cwd: "/test",
		storageDir: "/test",
		registry: mockRegistry,
		getSubagentPolicy: () => ({ mode: "inherit" as const, revision: 1 }),
	});

	assert.ok(installed.length >= 3);
});
