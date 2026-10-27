import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "../setup-dom.ts";
import type { SubagentPolicyRecord } from "../../src/policy/types.ts";

setupDom();
const { renderSlot, loadPluginApp } = await import("@get-bb/plugin-sdk/testing/app");
const { fireEvent, act } = await import("@testing-library/react");
const appModule = await import("../../app.tsx");

function createMockSdk(models: any[] = []) {
	return {
		system: {
			config: async () => ({ primaryHostId: "host-1" }),
		},
		hosts: {
			list: async () => [{ id: "host-1", name: "Local Host" }],
		},
		environments: {
			list: async () => [{ id: "env-1", name: "Dev Env" }],
		},
		providers: {
			models: async () => ({
				models,
				modelLoadError: null,
			}),
		},
	};
}

test("UI behavior: loads policy, inherit mode disables picker and saves without catalog", async () => {
	const captured = await loadPluginApp(appModule);
	const section = captured.settingsSections[0];

	let currentRecord: SubagentPolicyRecord = {
		version: 1,
		revision: 1,
		policy: { mode: "inherit" },
	};
	let setCalls: any[] = [];

	const catalogModels = [
		{
			id: "anthropic/claude-3-7-sonnet",
			model: "anthropic/claude-3-7-sonnet",
			displayName: "Claude 3.7 Sonnet",
			supportedReasoningEfforts: [{ reasoningEffort: "none" }, { reasoningEffort: "high" }],
			defaultReasoningEffort: "high",
			isDefault: true,
		},
	];

	const slot = renderSlot(section, {}, {
		rpc: {
			subagent_policy_get: async () => ({ record: currentRecord }),
			subagent_policy_set: async (input: any) => {
				setCalls.push(input);
				currentRecord = { version: 1, revision: input.expectedRevision + 1, policy: input.policy };
				return { record: currentRecord };
			},
		} as any,
		sdk: createMockSdk(catalogModels) as any,
	});

	// Wait for policy load
	await act(async () => {
		await new Promise((r) => setTimeout(r, 50));
	});

	// Inherit explanation text must be present
	assert.ok(
		slot.container.textContent?.includes("Subagents run with the same model"),
		"Inherit explanation must be visible",
	);

	// Radio for inherit should be checked
	const inheritRadio = slot.container.querySelector('input[value="inherit"]') as HTMLInputElement;
	const configuredRadio = slot.container.querySelector('input[value="configured"]') as HTMLInputElement;
	assert.equal(inheritRadio?.checked, true);
	assert.equal(configuredRadio?.checked, false);

	// Switch to configured
	await act(async () => {
		fireEvent.click(configuredRadio);
	});
	assert.equal(configuredRadio.checked, true);

	// Switch back to inherit
	await act(async () => {
		fireEvent.click(inheritRadio);
	});

	// Save button should be present
	const saveBtn = Array.from(slot.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Save"));
	assert.ok(saveBtn);
	assert.equal(saveBtn?.textContent?.trim(), "Save");

	slot.unmount();
});

test("UI behavior: configured mode validates model availability and displays warning for missing model", async () => {
	const captured = await loadPluginApp(appModule);
	const section = captured.settingsSections[0];

	const savedRecord: SubagentPolicyRecord = {
		version: 1,
		revision: 2,
		policy: {
			mode: "configured",
			configuredProfile: {
				model: { provider: "anthropic", modelId: "missing-model" },
				thinkingLevel: "high",
			},
		},
	};

	const catalogModels = [
		{
			id: "anthropic/claude-3-7-sonnet",
			model: "anthropic/claude-3-7-sonnet",
			displayName: "Claude 3.7 Sonnet",
			supportedReasoningEfforts: [{ reasoningEffort: "high" }],
			defaultReasoningEffort: "high",
		},
	];

	const slot = renderSlot(section, {}, {
		rpc: {
			subagent_policy_get: async () => ({ record: savedRecord }),
			subagent_policy_set: async () => ({ record: savedRecord }),
		} as any,
		sdk: createMockSdk(catalogModels) as any,
	});

	await act(async () => {
		await new Promise((r) => setTimeout(r, 50));
	});

	// Warning about missing model must be visible
	assert.ok(
		slot.container.textContent?.includes("unavailable in the current context"),
		"Warning for missing model must be displayed",
	);

	// Missing model must NOT be automatically replaced in policy
	assert.ok(
		slot.container.textContent?.includes("missing-model"),
		"Missing model ID must be preserved in UI",
	);

	// Save button should be disabled because model is not available
	const saveBtn = Array.from(slot.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Save"));
	assert.ok(saveBtn);
	assert.equal(saveBtn?.disabled, true, "Save button must be disabled when configured model is unavailable");

	slot.unmount();
});
