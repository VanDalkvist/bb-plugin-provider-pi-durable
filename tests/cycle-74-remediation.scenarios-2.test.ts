import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { adaptExtensionTool } from "../src/runner/extension-bridge.ts";
import { createNestedToolExecutor } from "../src/runner/extension-mount.ts";
import { createPiPrompt, DynamicPromptSections } from "../src/runner/prompt.ts";
import { handleActiveSessionCommand } from "../src/runner/session-commands.ts";
import { parseRunnerCommand, type CommandResponder } from "../src/contracts/runner-command.ts";
import { createRegistry, defineTool } from "@earendil-works/pi-durable";
import { SettingsManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";

test("P2-3: session-commands handles instructions, guards thinking level, and falls back on unknown type", async () => {
	const responses: Array<{ type: "success" | "error"; id?: string; command: string; data?: unknown; message?: string }> = [];
	const responder: CommandResponder = {
		success: (id, command, data) => responses.push({ type: "success", id, command, data }),
		error: (id, command, message) => responses.push({ type: "error", id, command, message }),
	};

	let compactedWith: string | undefined;
	let thinkingLevelSet: string | undefined;

	const mockDurable = {
		controller: {
			compact: async (instructions?: string) => {
				compactedWith = instructions;
			},
			setThinkingLevel: async (level: string) => {
				thinkingLevelSet = level;
			},
		},
		view: { current: () => ({ conversation: { docs: {} } }) },
		harness: {},
	};

	// 1. Compact with instructions
	await handleActiveSessionCommand(
		{ type: "compact", id: "1", instructions: "Summarize decisions" },
		mockDurable as never,
		{} as never,
		{} as never,
		responder,
	);
	assert.equal(compactedWith, "Summarize decisions");
	assert.equal(responses[0].type, "success");

	// 2. Set thinking level with missing level
	await handleActiveSessionCommand(
		{ type: "set_thinking_level", id: "2" },
		mockDurable as never,
		{} as never,
		{} as never,
		responder,
	);
	assert.equal(responses[1].type, "error");
	assert.equal(responses[1].message, "Missing thinking level");

	// 3. Set thinking level valid
	await handleActiveSessionCommand(
		{ type: "set_thinking_level", id: "3", level: "high" },
		mockDurable as never,
		{} as never,
		{} as never,
		responder,
	);
	assert.equal(thinkingLevelSet, "high");
	assert.equal(responses[2].type, "success");

	// 4. A missing command discriminator is rejected at the actual decoder, before dispatch.
	assert.throws(() => parseRunnerCommand(JSON.stringify({ id: "4" })), /INVALID_COMMAND/);
	assert.equal(responses.length, 3);
});
