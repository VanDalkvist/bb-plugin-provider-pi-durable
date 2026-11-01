import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { SettingsManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createPiPrompt } from "../src/runner/prompt.ts";
import { adaptExtensionTool } from "../src/runner/tool-adapter.ts";

describe("Tool Metadata Preservation & Prompt Canonical Parity (Cycle 98 - AP-026)", () => {
	it("adaptExtensionTool preserves promptSnippet and promptGuidelines on ToolRegistration", () => {
		const toolDef: ToolDefinition = {
			name: "custom_search",
			label: "Custom Search",
			description: "This is a very long description with lots of markdown text that should never appear in system prompt",
			promptSnippet: "Search project files quickly",
			promptGuidelines: ["Always prefer custom_search over grep"],
			parameters: Type.Object({ query: Type.String() }),
			execute: async () => ({ content: [] }),
		};

		const adapted = adaptExtensionTool(toolDef, async () => ({
			toolCall: {} as any,
			result: { content: [], details: {} },
			isError: false,
		}));

		assert.equal((adapted as any).promptSnippet, "Search project files quickly");
		assert.deepEqual((adapted as any).promptGuidelines, ["Always prefer custom_search over grep"]);
	});

	it("createPiPrompt renders promptSnippet and omits tools without promptSnippet from prompt text", () => {
		const settings = SettingsManager.inMemory();
		const extension = createPiPrompt(settings, "/test/cwd");
		const toolsSection = extension.sections?.find((s) => s.key === "tools");
		assert.ok(toolsSection);

		const toolWithSnippet: ToolDefinition = {
			name: "snippet_tool",
			label: "Snippet Tool",
			description: "Full description that should NOT appear in prompt text",
			promptSnippet: "One line summary of snippet tool",
			parameters: Type.Object({}),
			execute: async () => ({ content: [] }),
		};

		const toolWithoutSnippet: ToolDefinition = {
			name: "mcp_heavy_tool",
			label: "MCP Heavy Tool",
			description: "Heavy description of MCP tool spanning multiple paragraphs and schemas",
			parameters: Type.Object({}),
			execute: async () => ({ content: [] }),
		};

		const adaptedWith = adaptExtensionTool(toolWithSnippet, async () => ({} as any));
		const adaptedWithout = adaptExtensionTool(toolWithoutSnippet, async () => ({} as any));

		const input = {
			conversationId: "conv_test",
			agent: {
				cwd: "/test/cwd",
				tools: [
					{ name: "read" },
					adaptedWith,
					adaptedWithout,
				],
			},
		} as any;

		const rendered = toolsSection.render(input, {} as any) as string;

		// 1. Tool with snippet MUST be rendered with its snippet
		assert.ok(
			rendered.includes("- snippet_tool: One line summary of snippet tool"),
			`Prompt must contain snippet_tool snippet: ${rendered}`,
		);

		// 2. Full descriptions must NEVER be leaked into prompt text
		assert.ok(
			!rendered.includes("Full description that should NOT appear in prompt text"),
			"Prompt must not leak tool description",
		);
		assert.ok(
			!rendered.includes("Heavy description of MCP tool spanning multiple paragraphs"),
			"Prompt must not leak MCP tool description",
		);

		// 3. Tool without snippet must NOT be listed in tools text
		assert.ok(
			!rendered.includes("mcp_heavy_tool"),
			`Tool without snippet must be omitted from prompt text: ${rendered}`,
		);

		// 4. Canonical subagent tool MUST render with its canonical snippet
		const inputWithSubagent = {
			conversationId: "conv_test",
			agent: { cwd: "/test/cwd", tools: [{ name: "subagent" }] },
		} as any;
		const renderedSubagent = toolsSection.render(inputWithSubagent, {} as any) as string;
		assert.ok(
			renderedSubagent.includes("- subagent: Delegate a self-contained task to an async subagent"),
			`Prompt must contain canonical subagent snippet: ${renderedSubagent}`,
		);
	});
});
