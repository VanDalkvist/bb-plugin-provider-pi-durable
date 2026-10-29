import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { setupDom } from "../setup-dom.ts";
import type { TaskTreeItem } from "../../src/ui/runtime-graph/types.ts";

setupDom();
const { render, cleanup } = await import("@testing-library/react");
const { installTestPluginRuntime } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { RuntimeGraphTree } = await import("../../src/ui/runtime-graph/tree.tsx");
const { RuntimeGraphDetails } = await import("../../src/ui/runtime-graph/details.tsx");
const { formatTokens, formatDetailedTokens, formatTokenDelta, formatStepTokens } = await import("../../src/ui/runtime-graph/token-format.ts");
const { extractLiveTokens, extractTerminalTokens } = await import("../../src/runner/task-tokens.ts");

test.afterEach(() => {
	cleanup();
});

test("formatTokens: formats counts compactly for row display", () => {
	assert.equal(formatTokens(undefined), null);
	assert.equal(formatTokens(0), null);
	assert.equal(formatTokens(-10), null);
	assert.equal(formatTokens(450), "450 tok");
	assert.equal(formatTokens(999), "999 tok");
	assert.equal(formatTokens(1420), "1.4k tok");
	assert.equal(formatTokens(9800), "9.8k tok");
	assert.equal(formatTokens(25400), "25k tok");
	assert.equal(formatTokens(1500000), "1.5M tok");
});

test("formatDetailedTokens: produces detailed breakdown for inspector", () => {
	assert.equal(formatDetailedTokens(undefined), null);
	assert.equal(formatDetailedTokens({ total: 0 }), null);
	assert.equal(
		formatDetailedTokens({ total: 1420, input: 1100, output: 320, reasoning: 250, cacheRead: 850 }),
		"1,420 total (1,100 in · 320 out · 250 reasoning · 850 cache)",
	);
	assert.equal(formatDetailedTokens({ input: 500, output: 100 }), "600 total (500 in · 100 out)");
});

test("extractLiveTokens: extracts usage from pi.live generation message", () => {
	const genNode: any = { id: 10, kind: "pi.generation" };
	assert.equal(extractLiveTokens({ id: 11, kind: "pi.tool" } as any, {}), undefined);

	const current = {
		conversation: {
			docs: { "pi.live": { generation: { message: { usage: { totalTokens: 1850, input: 1200, output: 650, reasoning: 400 } } } } },
		},
	};
	const tokens = extractLiveTokens(genNode, current);
	assert.ok(tokens);
	assert.equal(tokens.total, 1850);
	assert.equal(tokens.input, 1200);
	assert.equal(tokens.output, 650);
	assert.equal(tokens.reasoning, 400);
});

test("extractTerminalTokens: extracts usage from AssistantEntry via outcome entryId", () => {
	const task: any = { id: 20, kind: "pi.generation", state: { status: "terminal", outcome: { status: "completed", result: { entryId: 105 } } } };
	const current = {
		conversation: {
			entries: [
				{ id: 104, kind: "pi.user" },
				{ id: 105, kind: "pi.assistant", model: [{ usage: { totalTokens: 2400, input: 1800, output: 600, reasoning: 350, cacheRead: 500 } }] },
			],
		},
	};
	const tokens = extractTerminalTokens(task, current);
	assert.ok(tokens);
	assert.equal(tokens.total, 2400);
	assert.equal(tokens.input, 1800);
	assert.equal(tokens.output, 600);
	assert.equal(tokens.reasoning, 350);
	assert.equal(tokens.cacheRead, 500);
});

test("formatTokenDelta: formats positive, zero, and negative deltas with k/M suffixes", () => {
	assert.equal(formatTokenDelta(undefined), null);
	assert.equal(formatTokenDelta(null as any), null);
	assert.equal(formatTokenDelta(0), "+0");
	assert.equal(formatTokenDelta(450), "+450");
	assert.equal(formatTokenDelta(1420), "+1.4k");
	assert.equal(formatTokenDelta(16500), "+17k");
	assert.equal(formatTokenDelta(-15200), "-15k");
	assert.equal(formatTokenDelta(1200000), "+1.2M");
});

test("formatStepTokens: formats token counts compactly without + sign", () => {
	assert.equal(formatStepTokens(undefined), null);
	assert.equal(formatStepTokens(null as any), null);
	assert.equal(formatStepTokens(0), null);
	assert.equal(formatStepTokens(320), "320");
	assert.equal(formatStepTokens(1420), "1.4k");
	assert.equal(formatStepTokens(16500), "17k");
	assert.equal(formatStepTokens(1200000), "1.2M");
});

test("RuntimeGraphTree: renders token count with icon and fixed separator before duration", () => {
	const completedTurn: TaskTreeItem = {
		id: 50, kind: "assistant turn", label: "assistant turn · gemini-3.8-flash (high)",
		conversationId: 1, isTerminal: true, children: [],
		tokenDelta: 1420,
		receipt: { taskId: 50, conversationId: 1, kind: "pi.generation", outcome: "completed", endedAt: 2000, durationMs: 1400, tokens: { total: 156420, input: 155000, output: 1420 } },
	};
	const { container } = render(
		React.createElement(RuntimeGraphTree, { tree: [completedTurn], selectedTaskId: null, collapsedTaskIds: new Set(), onSelectTask: () => {}, onToggleCollapse: () => {} }),
	);

	const row = container.querySelector("div[data-task-id='50']");
	assert.ok(row, "Row must exist");
	assert.ok(row.textContent?.includes("1.4k"), "Must display formatted token count without plus");
	assert.ok(!row.textContent?.includes("+1.4k"), "Must not include plus sign");
	assert.ok(row.textContent?.includes("·"), "Must display separator between tokens and duration");
	assert.ok(row.textContent?.includes("1.4s"), "Must display duration");
	assert.ok(row.querySelector("svg[data-icon='sparkles']"), "Must render sparkles token icon");
});

test("RuntimeGraphTree: renders task with output tokens directly (e.g. task #785 with 320 output tokens)", () => {
	const task785: TaskTreeItem = {
		id: 785, kind: "pi.generation", label: "pi.generation #785",
		conversationId: 1, isTerminal: true, children: [],
		receipt: {
			taskId: 785, conversationId: 1, kind: "pi.generation", outcome: "completed", endedAt: 2000, durationMs: 15600,
			tokens: { total: 367315, input: 2231, output: 320, reasoning: 152, cacheRead: 364764 },
		},
	};
	const { container } = render(
		React.createElement(RuntimeGraphTree, { tree: [task785], selectedTaskId: null, collapsedTaskIds: new Set(), onSelectTask: () => {}, onToggleCollapse: () => {} }),
	);

	const row = container.querySelector("div[data-task-id='785']");
	assert.ok(row, "Row must exist");
	assert.ok(row.textContent?.includes("320"), "Must display 320 output tokens, never 0");
	assert.ok(!row.textContent?.includes("+0"), "Must never display +0");
	assert.ok(row.textContent?.includes("15.6s"), "Must display duration");
});

test("RuntimeGraphTree: renders live tokens on active generation", () => {
	const activeTurn: TaskTreeItem = {
		id: 51, kind: "assistant turn", label: "assistant turn", conversationId: 1, isTerminal: false, children: [],
		liveNode: { id: 51, kind: "pi.generation", conversationId: 1, background: false, abortRequested: false, state: { status: "running", phase: "request" }, label: "assistant turn", startedAt: 1000, tokens: { total: 850, output: 250 } },
	};
	const { container } = render(
		React.createElement(RuntimeGraphTree, { tree: [activeTurn], selectedTaskId: null, collapsedTaskIds: new Set(), now: 3000, onSelectTask: () => {}, onToggleCollapse: () => {} }),
	);

	const row = container.querySelector("div[data-task-id='51']");
	assert.ok(row, "Active row must exist");
	assert.ok(row.textContent?.includes("250"), "Must display live token count");
	assert.ok(row.textContent?.includes("2.0s"), "Must display ticking live duration");
});

test("RuntimeGraphDetails: renders Tokens row with breakdown", () => {
	const turnItem: TaskTreeItem = {
		id: 52, kind: "assistant turn", label: "assistant turn", conversationId: 1, isTerminal: true, children: [],
		receipt: { taskId: 52, conversationId: 1, kind: "pi.generation", outcome: "completed", endedAt: 2000, durationMs: 1400, tokens: { total: 1420, input: 1100, output: 320, reasoning: 250 } },
	};
	const { container } = render(React.createElement(RuntimeGraphDetails, { selectedItem: turnItem, onClose: () => {} }));
	assert.ok(container.textContent?.includes("Tokens"), "Details must render Tokens label");
	assert.ok(container.textContent?.includes("1,420 total (1,100 in · 320 out · 250 reasoning)"), "Details must render token breakdown");
});
