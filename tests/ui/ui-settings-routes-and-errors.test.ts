import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "../setup-dom.ts";
import type { SubagentPolicyRecord } from "../../src/policy/types.ts";

setupDom();
const { renderSlot, loadPluginApp } = await import("@get-bb/plugin-sdk/testing/app");
const { fireEvent, act } = await import("@testing-library/react");
const appModule = await import("../../app.tsx");

test("UI routes & errors: conflict preserves user draft and updates expectedRevision for retry", async () => {
	const captured = await loadPluginApp(appModule);
	const section = captured.settingsSections[0];

	let serverRecord: SubagentPolicyRecord = {
		version: 1,
		revision: 1,
		policy: { mode: "inherit" },
	};

	let attempts = 0;
	const slot = renderSlot(section, {}, {
		rpc: {
			subagent_policy_get: async () => ({ record: serverRecord }),
			subagent_policy_set: async (input: any) => {
				attempts++;
				if (input.expectedRevision === 1) {
					// Simulate server updated concurrently by another client to revision 2
					serverRecord = {
						version: 1,
						revision: 2,
						policy: { mode: "inherit" },
					};
					const err: any = new Error("Revision conflict: expected 1 but current is 2");
					err.code = "conflict";
					throw err;
				}
				serverRecord = {
					version: 1,
					revision: input.expectedRevision + 1,
					policy: input.policy,
				};
				return { record: serverRecord };
			},
		} as any,
		sdk: {
			system: { config: async () => ({ primaryHostId: "h1" }) },
			hosts: { list: async () => [{ id: "h1" }] },
			environments: { list: async () => [] },
			providers: {
				models: async () => ({
					models: [
						{
							id: "p/m",
							model: "p/m",
							isDefault: true,
							defaultReasoningEffort: "high",
							supportedReasoningEfforts: [{ reasoningEffort: "high" }],
						},
					],
					modelLoadError: null,
				}),
			},
		} as any,
	});

	await act(async () => {
		await new Promise((r) => setTimeout(r, 50));
	});

	// Switch to configured
	const configuredRadio = slot.container.querySelector('input[value="configured"]') as HTMLInputElement;
	await act(async () => {
		fireEvent.click(configuredRadio);
	});

	// Attempt 1: Save triggers conflict
	const saveBtn = Array.from(slot.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Сохранить"))!;
	await act(async () => {
		fireEvent.click(saveBtn);
		await new Promise((r) => setTimeout(r, 50));
	});

	assert.equal(attempts, 1);
	// Conflict message displayed
	assert.ok(slot.container.textContent?.includes("Конфликт изменений"), "Conflict message must be visible");
	// User draft is preserved (still configured mode!)
	assert.equal(configuredRadio.checked, true, "Configured radio must remain checked after conflict");

	// Attempt 2: Retry with updated expectedRevision (2)
	await act(async () => {
		fireEvent.click(saveBtn);
		await new Promise((r) => setTimeout(r, 50));
	});

	assert.equal(attempts, 2);
	assert.equal(serverRecord.revision, 3, "Policy must be saved with revision incremented");
	assert.equal(serverRecord.policy.mode, "configured");

	slot.unmount();
});

test("UI routes & errors: handles modelLoadError and offline catalog without crashing", async () => {
	const captured = await loadPluginApp(appModule);
	const section = captured.settingsSections[0];

	const record: SubagentPolicyRecord = {
		version: 1,
		revision: 1,
		policy: { mode: "inherit" },
	};

	const slot = renderSlot(section, {}, {
		rpc: {
			subagent_policy_get: async () => ({ record }),
			subagent_policy_set: async () => ({ record }),
		} as any,
		sdk: {
			system: { config: async () => ({ primaryHostId: "h1" }) },
			hosts: { list: async () => [{ id: "h1", name: "Host 1" }, { id: "h2", name: "Host 2" }] },
			environments: { list: async () => [] },
			providers: {
				models: async (args: any) => {
					if (args.hostId === "h2") {
						return {
							models: [],
							modelLoadError: { code: "provider_unavailable", detail: "Host daemon unreachable" },
						};
					}
					return { models: [], modelLoadError: null };
				},
			},
		} as any,
	});

	await act(async () => {
		await new Promise((r) => setTimeout(r, 50));
	});

	// Switch preview routing to h2
	const hostSelect = slot.container.querySelector('select[aria-label="Выбор хоста для предпросмотра"]') as HTMLSelectElement;
	assert.ok(hostSelect, "Host select must exist");

	await act(async () => {
		fireEvent.change(hostSelect, { target: { value: "h2" } });
		await new Promise((r) => setTimeout(r, 50));
	});

	// Error message should be rendered
	assert.ok(
		slot.container.textContent?.includes("provider_unavailable") || slot.container.textContent?.includes("unreachable"),
		"Model load error must be shown",
	);

	slot.unmount();
});
