import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupDom } from "../setup-dom.ts";

test("UI manifest and slot registration: defines bb.app and registers subagent-model-policy slot", async () => {
	const projectRoot = path.resolve(import.meta.dirname, "../..");
	const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));

	// 1. Verify manifest bb.app
	assert.equal(pkg.bb?.app, "./app.tsx", "package.json must declare bb.app: './app.tsx'");

	// 2. Setup DOM and test loadPluginApp
	setupDom();
	const { loadPluginApp } = await import("@get-bb/plugin-sdk/testing/app");
	const appModule = await import("../../app.tsx");

	const captured = await loadPluginApp(appModule);

	// 3. Verify exactly one settingsSection registered
	assert.equal(captured.settingsSections.length, 1);
	const section = captured.settingsSections[0];
	assert.equal(section.id, "subagent-model-policy");
	assert.equal(section.title, "Subagents");
	assert.equal(typeof section.component, "function");

	// 4. Verify no old Doctor view is registered
	assert.equal(captured.navPanels.length, 0);
	assert.equal(captured.homepageSections.length, 0);
});
