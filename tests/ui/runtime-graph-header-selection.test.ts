import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { setupDom } from "../setup-dom.ts";
import type { TaskTreeItem } from "../../src/ui/runtime-graph/types.ts";

setupDom();
const { render, cleanup } = await import("@testing-library/react");
const { installTestPluginRuntime } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { RuntimeGraphSummary } = await import("../../src/ui/runtime-graph/summary.tsx");

test.afterEach(() => {
	cleanup();
});

function makeTask(id: number, isTerminal = true, outcome: any = "completed", isToolError = false): TaskTreeItem {
	return {
		id, kind: "pi.tool", label: `Task #${id}`, conversationId: 1,
		isTerminal, children: [],
		receipt: isTerminal ? {
			taskId: id, conversationId: 1, kind: "pi.tool", outcome, isToolError,
			endedAt: 1000 + id, durationMs: 15,
		} : undefined,
		liveNode: !isTerminal ? {
			id, kind: "pi.tool", conversationId: 1, background: false, abortRequested: false,
			state: { status: "running" }, label: `Task #${id}`, startedAt: 1000,
		} : undefined,
	};
}

function makeActiveState(activeCount = 2, totalCount = 130, isStale = false, isLimited = false, hasToolError = false) {
	const liveNodes: Record<string, any> = {};
	for (let i = 1; i <= activeCount; i++) {
		liveNodes[String(i)] = makeTask(i, false).liveNode;
	}
	const terminalCount = totalCount - activeCount;
	const receipts = Array.from({ length: terminalCount }, (_, i) =>
		makeTask(100 + i, true, "completed", i === 0 && hasToolError).receipt,
	);
	return {
		threadId: "thr-1",
		status: isStale ? "unavailable" : "ok",
		snapshot: {
			nodes: liveNodes,
			receipts,
			stats: { liveCount: activeCount, terminalCount, totalCount },
			observation: isLimited ? { completeness: "limited" } : { completeness: "complete" },
		},
		tree: [],
		selectedTaskId: null,
		selectedItem: null,
		collapsedTaskIds: new Set<number>(),
		selectTask: () => {},
		toggleCollapse: () => {},
	};
}

function makeCompletedState(terminalCount = 10) {
	const receipts = Array.from({ length: terminalCount }, (_, i) => makeTask(100 + i, true).receipt);
	return {
		threadId: "thr-1",
		status: "ok",
		snapshot: {
			nodes: {},
			receipts,
			stats: { liveCount: 0, terminalCount, totalCount: terminalCount },
			observation: { completeness: "complete" },
		},
		tree: [],
		selectedTaskId: null,
		selectedItem: null,
		collapsedTaskIds: new Set<number>(),
		selectTask: () => {},
		toggleCollapse: () => {},
	};
}

test("RED: isExpanded=false AND active>0 renders muted header title, count, and aria-expanded=false", () => {
	const activeState = makeActiveState(2, 130);
	const { container } = render(
		React.createElement(RuntimeGraphSummary, {
			threadId: "thr-1", projectId: "p-1", environment: null, segments: [],
			isExpanded: false, onToggle: () => {}, testState: activeState as any,
		}),
	);

	const btn = container.querySelector("button");
	assert.ok(btn, "Header button must exist");
	assert.equal(btn?.getAttribute("aria-expanded"), "false", "Accessibility: aria-expanded must be false when collapsed");

	const title = container.querySelector("button > span.font-semibold");
	assert.ok(title, "Title span must exist");
	assert.ok(
		title.classList.contains("text-muted-foreground"),
		`Collapsed title must be text-muted-foreground, got: ${title.className}`,
	);
	assert.ok(
		!title.classList.contains("text-foreground"),
		"Collapsed title must NOT be text-foreground even when active > 0",
	);

	assert.ok(container.textContent?.includes("2 active of 130"), "Preserves N active of M formatting");

	// Summary content (count) span must also be muted grey when unselected
	const countSpan = container.querySelector("button > span[data-summary-count='true']");
	assert.ok(countSpan, "Count span must exist");
	assert.ok(
		countSpan.classList.contains("text-muted-foreground"),
		`Collapsed count must be text-muted-foreground, got: ${countSpan.className}`,
	);
	assert.ok(
		!countSpan.classList.contains("text-foreground"),
		"Collapsed count must NOT be text-foreground when isExpanded=false",
	);
});

test("GREEN: isExpanded=true AND active>0 renders text-foreground title, count, and aria-expanded=true", () => {
	const activeState = makeActiveState(2, 130);
	const { container } = render(
		React.createElement(RuntimeGraphSummary, {
			threadId: "thr-1", projectId: "p-1", environment: null, segments: [],
			isExpanded: true, onToggle: () => {}, testState: activeState as any,
		}),
	);

	const btn = container.querySelector("button");
	assert.ok(btn, "Header button must exist");
	assert.equal(btn?.getAttribute("aria-expanded"), "true", "Accessibility: aria-expanded must be true when expanded");

	const title = container.querySelector("button > span.font-semibold");
	assert.ok(title, "Title span must exist");
	assert.ok(
		title.classList.contains("text-foreground"),
		`Expanded title must be text-foreground, got: ${title?.className}`,
	);

	const countSpan = container.querySelector("button > span[data-summary-count='true']");
	assert.ok(countSpan, "Count span must exist");
	assert.ok(
		countSpan.classList.contains("text-foreground"),
		`Expanded count must be text-foreground, got: ${countSpan?.className}`,
	);
	assert.ok(container.textContent?.includes("2 active of 130"));
});

test("Selection state with active=0 (completed): collapsed is muted, expanded is text-foreground", () => {
	const completedState = makeCompletedState(10);

	// Collapsed completed
	const { container: cCollapsed } = render(
		React.createElement(RuntimeGraphSummary, {
			threadId: "thr-1", projectId: "p-1", environment: null, segments: [],
			isExpanded: false, onToggle: () => {}, testState: completedState as any,
		}),
	);
	const btnCollapsed = cCollapsed.querySelector("button");
	assert.equal(btnCollapsed?.getAttribute("aria-expanded"), "false");
	const titleCollapsed = cCollapsed.querySelector("button > span.font-semibold");
	assert.ok(titleCollapsed?.classList.contains("text-muted-foreground"));
	const countCollapsed = cCollapsed.querySelector("button > span[data-summary-count='true']");
	assert.ok(countCollapsed?.classList.contains("text-muted-foreground"));

	// Expanded completed
	const { container: cExpanded } = render(
		React.createElement(RuntimeGraphSummary, {
			threadId: "thr-1", projectId: "p-1", environment: null, segments: [],
			isExpanded: true, onToggle: () => {}, testState: completedState as any,
		}),
	);
	const btnExpanded = cExpanded.querySelector("button");
	assert.equal(btnExpanded?.getAttribute("aria-expanded"), "true");
	const titleExpanded = cExpanded.querySelector("button > span.font-semibold");
	assert.ok(titleExpanded?.classList.contains("text-foreground"), "Expanded title must be text-foreground");
	const countExpanded = cExpanded.querySelector("button > span[data-summary-count='true']");
	assert.ok(countExpanded?.classList.contains("text-foreground"), "Expanded count must be text-foreground");
});

test("Stale, Limited, and Tool Error honesty preserved across expansion states", () => {
	const staleLimitedState = makeActiveState(1, 10, true, true, true);
	const { container } = render(
		React.createElement(RuntimeGraphSummary, {
			threadId: "thr-1", projectId: "p-1", environment: null, segments: [],
			isExpanded: false, onToggle: () => {}, testState: staleLimitedState as any,
		}),
	);

	assert.ok(container.textContent?.includes("Stale"), "Must render Stale badge");
	assert.ok(container.textContent?.includes("Limited"), "Must render Limited badge");
	assert.ok(container.textContent?.includes("tool error"), "Must render tool error badge");
});
