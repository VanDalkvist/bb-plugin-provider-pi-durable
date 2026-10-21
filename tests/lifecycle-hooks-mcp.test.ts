import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SUPPORTED_EXTENSION_HOOKS } from "../src/runner/diagnostics-types.ts";
import { setupExtensionRunner } from "../src/runner/extension-bridge.ts";
import {
	DefaultResourceLoader,
	ExtensionRunner,
	ModelRuntime,
	SettingsManager,
	type Extension,
} from "@earendil-works/pi-coding-agent";

describe("Lifecycle Hooks & MCP Canon (Cycle 100)", () => {
	it("SUPPORTED_EXTENSION_HOOKS includes agent_end, agent_settled, and session_before_compact", () => {
		assert.equal(SUPPORTED_EXTENSION_HOOKS.has("agent_end"), true);
		assert.equal(SUPPORTED_EXTENSION_HOOKS.has("agent_settled"), true);
		assert.equal(SUPPORTED_EXTENSION_HOOKS.has("session_before_compact"), true);
		assert.equal(SUPPORTED_EXTENSION_HOOKS.has("session_compact"), true);
		assert.equal(SUPPORTED_EXTENSION_HOOKS.has("before_agent_start"), true);
		assert.equal(SUPPORTED_EXTENSION_HOOKS.has("session_start"), true);
		assert.equal(SUPPORTED_EXTENSION_HOOKS.has("session_shutdown"), true);
	});

	it("actions.getAllTools() exposes host callable tools with reachesTools: true", async () => {
		let registeredActions: any;
		const origBind = ExtensionRunner.prototype.bindCore;
		ExtensionRunner.prototype.bindCore = function (actions, ctxActions) {
			registeredActions = actions;
			return origBind.call(this, actions, ctxActions);
		};

		const loader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: "/tmp/pi-test-agent",
			settingsManager: SettingsManager.create(process.cwd()),
		});
		await loader.reload();
		const { runtime } = loader.getExtensions();

		try {
			await setupExtensionRunner({
				extensions: [],
				runtime,
				cwd: process.cwd(),
				modelRuntime: await ModelRuntime.create(),
				executeToolFn: async () => ({
					toolCall: { type: "toolCall", id: "1", name: "test", arguments: {} },
					result: { content: [], details: {} },
					isError: false,
				}),
				getCallableTools: () => [
					{ name: "read", description: "Read file", parameters: {} },
					{ name: "codemode", description: "Codemode sandbox", parameters: {} },
					{ name: "tool_search", description: "Search tools", parameters: {} },
				],
			});

			assert.ok(registeredActions);
			const allTools = registeredActions.getAllTools();
			const codemode = allTools.find((t: any) => t.name === "codemode");
			const toolSearch = allTools.find((t: any) => t.name === "tool_search");
			const read = allTools.find((t: any) => t.name === "read");

			assert.ok(codemode, "codemode tool should be present");
			assert.equal(codemode.reachesTools, true, "codemode must have reachesTools: true");
			assert.ok(toolSearch, "tool_search tool should be present");
			assert.equal(toolSearch.reachesTools, true, "tool_search must have reachesTools: true");
			assert.ok(read, "read tool should be present");
			assert.equal(read.reachesTools, false, "read must have reachesTools: false");
		} finally {
			ExtensionRunner.prototype.bindCore = origBind;
		}
	});

	it("ExtensionRunner handles agent_end, agent_settled, and session_before_compact cleanly", async () => {
		let agentEndCalled = false;
		let agentSettledCalled = false;
		let beforeCompactCalled = false;

		const mockExtension: any = {
			id: "test-lifecycle",
			name: "test-lifecycle",
			handlers: new Map([
				["agent_end", [() => { agentEndCalled = true; }]],
				["agent_settled", [() => { agentSettledCalled = true; }]],
				["session_before_compact", [() => { beforeCompactCalled = true; }]],
			]),
		};

		const loader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: "/tmp/pi-test-agent",
			settingsManager: SettingsManager.create(process.cwd()),
		});
		await loader.reload();
		const { runtime } = loader.getExtensions();

		const runner = await setupExtensionRunner({
			extensions: [mockExtension],
			runtime,
			cwd: process.cwd(),
			modelRuntime: await ModelRuntime.create(),
			executeToolFn: async () => ({
				toolCall: { type: "toolCall", id: "1", name: "test", arguments: {} },
				result: { content: [], details: {} },
				isError: false,
			}),
		});

		await runner.emit({ type: "agent_end", messages: [] });
		assert.equal(agentEndCalled, true, "agent_end handler must be called");

		await runner.emit({ type: "agent_settled", aborted: false });
		assert.equal(agentSettledCalled, true, "agent_settled handler must be called");

		await runner.emit({
			type: "session_before_compact",
			preparation: {
				firstKeptEntryId: "",
				messagesToSummarize: [],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 0,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: {} as any,
			},
			branchEntries: [],
			customInstructions: "test compact",
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		});
		assert.equal(beforeCompactCalled, true, "session_before_compact handler must be called");
	});
});
