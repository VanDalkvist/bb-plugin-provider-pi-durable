import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "../setup-dom.ts";
import type { SubagentPolicyRecord } from "../../src/policy/types.ts";

setupDom();
const { renderSlot, loadPluginApp } = await import("@get-bb/plugin-sdk/testing/app");
const { fireEvent, act } = await import("@testing-library/react");
const appModule = await import("../../app.tsx");

test("UI fixes: radio inputs are disabled while isSaving is true (Finding 3)", async () => {
	const captured = await loadPluginApp(appModule);
	const section = captured.settingsSections[0];

	let resolveSave!: (res: any) => void;
	const savePromise = new Promise((resolve) => { resolveSave = resolve; });

	const initialRecord: SubagentPolicyRecord = {
		version: 1, revision: 1,
		policy: { mode: "configured", configuredProfile: { model: { provider: "p1", modelId: "m1" }, thinkingLevel: "high" } },
	};

	let slot: any;
	try {
		slot = renderSlot(section, {}, {
			rpc: { subagent_policy_get: async () => ({ record: initialRecord }), subagent_policy_set: async () => await savePromise } as any,
			sdk: {
				system: { config: async () => ({ primaryHostId: "h1" }) },
				hosts: { list: async () => [{ id: "h1" }] },
				environments: { list: async () => [] },
				providers: {
					models: async () => ({
						models: [{ id: "p1/m1", model: "p1/m1", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }],
						modelLoadError: null,
					}),
				},
			} as any,
		});

		await act(async () => {
			await new Promise((r) => setTimeout(r, 60));
		});

		const inheritRadio = slot.container.querySelector('input[value="inherit"]') as HTMLInputElement;
		const configuredRadio = slot.container.querySelector('input[value="configured"]') as HTMLInputElement;
		assert.ok(inheritRadio && configuredRadio);

		await act(async () => { fireEvent.click(inheritRadio); });

		const saveBtn = Array.from(slot.container.querySelectorAll("button")).find((b: any) => b.textContent?.includes("Save")) as HTMLButtonElement;
		assert.ok(saveBtn);
		assert.equal(saveBtn.disabled, false, "Save must be enabled with changes");

		await act(async () => {
			fireEvent.click(saveBtn);
			await new Promise((r) => setTimeout(r, 20));
		});

		assert.equal(inheritRadio.disabled, true, "Inherit radio must be disabled while isSaving");
		assert.equal(configuredRadio.disabled, true, "Configured radio must be disabled while isSaving");

		await act(async () => {
			resolveSave({ record: { version: 1, revision: 2, policy: { mode: "inherit" } } });
			await new Promise((r) => setTimeout(r, 20));
		});
	} finally {
		slot?.unmount();
	}
});

test("UI fixes: AbortController aborts in-flight catalog query on route change and unmount (Finding 4)", async () => {
	const captured = await loadPluginApp(appModule);
	const section = captured.settingsSections[0];

	const signals: AbortSignal[] = [];

	let slot: any;
	try {
		slot = renderSlot(section, {}, {
			rpc: {
				subagent_policy_get: async () => ({ record: { version: 1, revision: 1, policy: { mode: "inherit" } } }),
				subagent_policy_set: async (i: any) => ({ record: { version: 1, revision: 2, policy: i.policy } }),
			} as any,
			sdk: {
				system: { config: async () => ({ primaryHostId: "h1" }) },
				hosts: { list: async () => [{ id: "h1", name: "Host 1" }, { id: "h2", name: "Host 2" }] },
				environments: { list: async () => [] },
				providers: {
					models: async (args: any) => {
						if (args.signal) signals.push(args.signal);
						return new Promise(() => {}); // keep in flight
					},
				},
			} as any,
		});

		await act(async () => {
			await new Promise((r) => setTimeout(r, 60));
		});

		assert.equal(signals.length, 1, "First query initiated");
		const firstSignal = signals[0];
		assert.equal(firstSignal.aborted, false, "First signal not aborted yet");

		const hostSelect = slot.container.querySelector('select[aria-label="Select host for preview"]') as HTMLSelectElement;
		assert.ok(hostSelect);

		await act(async () => {
			fireEvent.change(hostSelect, { target: { value: "h2" } });
			await new Promise((r) => setTimeout(r, 30));
		});

		assert.equal(firstSignal.aborted, true, "First signal must be aborted on route change");
		assert.equal(signals.length, 2, "Second query initiated");
		const secondSignal = signals[1];
		assert.equal(secondSignal.aborted, false, "Second signal active");

		slot.unmount();
		slot = null;
		assert.equal(secondSignal.aborted, true, "Second signal must be aborted on unmount");
	} finally {
		slot?.unmount();
	}
});

test("UI fixes: empty hosts and null primaryHostId sets routing to null without fake default (Finding 5)", async () => {
	const captured = await loadPluginApp(appModule);
	const section = captured.settingsSections[0];

	let queriedHostId: string | undefined = undefined;

	let slot: any;
	try {
		slot = renderSlot(section, {}, {
			rpc: {
				subagent_policy_get: async () => ({ record: { version: 1, revision: 1, policy: { mode: "inherit" } } }),
				subagent_policy_set: async (i: any) => ({ record: { version: 1, revision: 2, policy: i.policy } }),
			} as any,
			sdk: {
				system: { config: async () => ({ primaryHostId: null }) },
				hosts: { list: async () => [] },
				environments: { list: async () => [] },
				providers: {
					models: async (args: any) => {
						queriedHostId = args.hostId;
						return { models: [], modelLoadError: null };
					},
				},
			} as any,
		});

		await act(async () => {
			await new Promise((r) => setTimeout(r, 60));
		});

		assert.equal(queriedHostId, undefined, "No models query should be made to fake 'default' host");
		assert.ok(slot.container.textContent?.includes("No available hosts or environments to preview models."), "Empty context message should be shown");
	} finally {
		slot?.unmount();
	}
});

test("UI fixes: canSaveConfigured is blocked when modelLoadError is present", async () => {
	const captured = await loadPluginApp(appModule);
	const section = captured.settingsSections[0];
	const initialRecord: SubagentPolicyRecord = {
		version: 1, revision: 1,
		policy: { mode: "inherit", configuredProfile: { model: { provider: "p1", modelId: "m1" }, thinkingLevel: "high" } },
	};
	let slot: any;
	try {
		slot = renderSlot(section, {}, {
			rpc: { subagent_policy_get: async () => ({ record: initialRecord }), subagent_policy_set: async () => ({ record: initialRecord }) } as any,
			sdk: {
				system: { config: async () => ({ primaryHostId: "h1" }) },
				hosts: { list: async () => [{ id: "h1" }] },
				environments: { list: async () => [] },
				providers: {
					models: async () => ({
						models: [{ id: "p1/m1", model: "p1/m1", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }],
						modelLoadError: { code: "AUTH_FAILED", detail: "Invalid key" },
					}),
				},
			} as any,
		});
		await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
		const configuredRadio = slot.container.querySelector('input[value="configured"]') as HTMLInputElement;
		await act(async () => { fireEvent.click(configuredRadio); });
		const saveBtn = Array.from(slot.container.querySelectorAll("button")).find((b: any) => b.textContent?.includes("Save")) as HTMLButtonElement;
		assert.ok(saveBtn);
		assert.equal(saveBtn.disabled, true, "Save button must be disabled when modelLoadError is present");
	} finally {
		slot?.unmount();
	}
});
