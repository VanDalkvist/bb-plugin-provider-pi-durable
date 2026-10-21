import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPiPrompt } from "../src/runner/prompt.ts";
import { DynamicCodemodeNamespaces } from "../src/runner/codemode-namespaces.ts";
import { createCodingRegistry } from "../src/runner/harness-setup.ts";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";

describe("Codemode Canonical Routines (Cycle 101)", () => {
	it("renders canonical snippet for codemode and tool_search in <tools>", () => {
		const mockSettings = {
			getGlobalSettings: () => ({}),
			getProjectSettings: () => ({}),
		} as unknown as SettingsManager;

		const promptExt = createPiPrompt(mockSettings, "/test/cwd");
		const toolsSection = promptExt.sections.find((s) => s.key === "tools");
		assert.ok(toolsSection, "tools section must be registered");

		const mockInput = {
			agent: {
				cwd: "/test/cwd",
				tools: [
					{ name: "read", description: "Read file" },
					{ name: "bash", description: "Bash command" },
					{ name: "codemode", description: "Raw codemode docs..." },
					{ name: "tool_search", description: "Raw tool_search docs..." },
				],
			},
		} as any;

		const rendered = toolsSection.render(mockInput, {} as any) as string;
		assert.ok(rendered, "tools section must render content");

		// Canonical snippets must replace raw long technical descriptions
		assert.match(
			rendered,
			/- codemode: Run JavaScript in a sandbox to call other tools\. Use it to batch, chain, or loop tool calls without roundtrips\./,
		);
		assert.match(
			rendered,
			/- tool_search: Search for deferred tools by keyword or concept and load matching tools for subsequent calls\./,
		);
	});

	it("injects canonical batching rule for codemode into <rules>", () => {
		const mockSettings = {
			getGlobalSettings: () => ({}),
			getProjectSettings: () => ({}),
		} as unknown as SettingsManager;

		const promptExt = createPiPrompt(mockSettings, "/test/cwd");
		const rulesSection = promptExt.sections.find((s) => s.key === "rules");
		assert.ok(rulesSection, "rules section must be registered");

		const mockInput = {
			agent: {
				cwd: "/test/cwd",
				tools: [
					{ name: "read" },
					{ name: "bash" },
					{ name: "codemode" },
					{ name: "tool_search" },
				],
			},
		} as any;

		const rendered = rulesSection.render(mockInput, {} as any) as string;
		assert.ok(rendered, "rules section must render content");

		assert.match(
			rendered,
			/- Use codemode to batch independent tool calls \(Promise\.allSettled\), chain them, or filter large output, instead of many separate calls\./,
		);
		assert.match(
			rendered,
			/- Use tool_search to discover and activate deferred tools before calling them\./,
		);
	});

	it("dynamically extracts namespaces from MCP tools without hardcoding", () => {
		const dynamic = new DynamicCodemodeNamespaces();

		const toolDefs = [
			{
				name: "mcp__gbrain__recall",
				namespace: { name: "gbrain", description: "GBrain Memory System", instructions: "Use recall first" },
			},
			{
				name: "mcp__gbrain__query",
				namespace: { name: "gbrain", description: "GBrain Memory System" },
			},
			{
				name: "mcp__telegram__send_message",
				namespace: { name: "telegram", description: "Telegram Bot Integration" },
			},
			{
				name: "custom_tool",
			},
		];

		dynamic.registerFromToolDefinitions(toolDefs);
		const namespaces = dynamic.getNamespaces();

		assert.equal(namespaces.length, 2, "must extract exactly 2 namespaces (gbrain, telegram)");

		const gbrainNs = namespaces.find((n) => n.name === "gbrain");
		assert.ok(gbrainNs, "gbrain namespace must be extracted");
		assert.equal(gbrainNs.prefix, "mcp__gbrain__");
		assert.equal(gbrainNs.description, "GBrain Memory System");

		const telegramNs = namespaces.find((n) => n.name === "telegram");
		assert.ok(telegramNs, "telegram namespace must be extracted");
		assert.equal(telegramNs.prefix, "mcp__telegram__");
		assert.equal(telegramNs.description, "Telegram Bot Integration");
	});

	it("passes dynamic namespaces to createCodingRegistry codemode extension", async () => {
		const dynamic = new DynamicCodemodeNamespaces();
		dynamic.registerFromToolDefinitions([
			{
				name: "mcp__custom_server__do_action",
				namespace: { name: "custom_server", description: "Custom server" },
			},
		]);

		const mockSettings = {
			getGlobalSettings: () => ({}),
			getProjectSettings: () => ({}),
		} as unknown as SettingsManager;

		const registry = await createCodingRegistry(mockSettings, "/test/cwd", undefined, dynamic);
		assert.ok(registry, "registry must be created");

		const snapshot = registry.snapshot();
		const codemodeTool = snapshot.tools().find((t) => t.tool.name === "codemode");
		assert.ok(codemodeTool, "codemode tool must be installed in registry");
	});
});
