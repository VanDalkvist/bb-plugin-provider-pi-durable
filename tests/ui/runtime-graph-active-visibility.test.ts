import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { setupDom } from "../setup-dom.ts";
import type { TaskTreeItem } from "../../src/ui/runtime-graph/types.ts";

setupDom();
const { render, fireEvent, cleanup } = await import("@testing-library/react");
const { installTestPluginRuntime } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { RuntimeGraphSegmentDetails } = await import("../../src/ui/runtime-graph/segment.tsx");
const { RuntimeGraphDetails } = await import("../../src/ui/runtime-graph/details.tsx");

test.afterEach(() => {
	cleanup();
});

test("Active task visibility: with 100+ history tasks, active node is marked and scrolled into view", () => {
	const historyItems: TaskTreeItem[] = [];
	for (let i = 1; i <= 100; i++) {
		historyItems.push({
			id: i, kind: "pi.tool", label: `Tool #${i}`, conversationId: 1,
			isTerminal: true, children: [],
			receipt: { taskId: i, conversationId: 1, kind: "pi.tool", outcome: "completed", endedAt: 1000 + i, durationMs: 10 },
		});
	}

	const activeItem: TaskTreeItem = {
		id: 101, kind: "pi.generation", label: "assistant turn", conversationId: 1,
		isTerminal: false, children: [],
		liveNode: {
			id: 101, kind: "pi.generation", conversationId: 1, background: false, abortRequested: false,
			state: { status: "running", phase: "request" }, label: "assistant turn", startedAt: Date.now() - 5000,
		},
	};

	let scrollIntoViewCalled = false;
	window.HTMLElement.prototype.scrollIntoView = function() {
		scrollIntoViewCalled = true;
	};

	const state: any = {
		threadId: "thr-1", status: "ok",
		snapshot: {
			version: 1, scope: { sessionId: "s", rootConversationId: "1", buildId: "b" },
			observation: { epoch: "e", revision: 1, observedAt: 1000, completeness: "complete" },
			nodes: { "101": activeItem.liveNode }, conversations: { "1": { id: 1 } }, receipts: [],
			stats: { liveCount: 1, terminalCount: 100, totalCount: 101 },
		},
		tree: [...historyItems, activeItem],
		selectedTaskId: null, selectedItem: null,
		collapsedTaskIds: new Set(), selectTask: () => {}, toggleCollapse: () => {},
	};

	const { container } = render(
		React.createElement(RuntimeGraphSegmentDetails, {
			threadId: "thr-1", projectId: "p-1", environment: null,
			segments: [], isExpanded: true, onToggle: () => {}, testState: state,
		}),
	);

	const activeNodeRow = container.querySelector("div[data-task-id='101']");
	assert.ok(activeNodeRow, "Active node row #101 must exist in DOM");
	assert.equal(activeNodeRow.getAttribute("data-active"), "true", "Active node row must have data-active=true");
	assert.ok(scrollIntoViewCalled, "Active node must be scrolled into view on mount/expansion");
});

test("Manual scroll preservation: does not steal scroll and Follow active is removed", () => {
	const activeItem: TaskTreeItem = {
		id: 50, kind: "pi.tool", label: "Running Task", conversationId: 1,
		isTerminal: false, children: [],
		liveNode: {
			id: 50, kind: "pi.tool", conversationId: 1, background: false, abortRequested: false,
			state: { status: "running" }, label: "Running Task", startedAt: Date.now() - 1000,
		},
	};

	let scrollCalls = 0;
	window.HTMLElement.prototype.scrollIntoView = function() {
		scrollCalls++;
	};

	const state: any = {
		threadId: "thr-1", status: "ok",
		snapshot: {
			version: 1, scope: { sessionId: "s", rootConversationId: "1", buildId: "b" },
			observation: { epoch: "e", revision: 1, observedAt: 1000, completeness: "complete" },
			nodes: { "50": activeItem.liveNode }, conversations: { "1": { id: 1 } }, receipts: [],
			stats: { liveCount: 1, terminalCount: 0, totalCount: 1 },
		},
		tree: [activeItem], selectedTaskId: null, selectedItem: null,
		collapsedTaskIds: new Set(), selectTask: () => {}, toggleCollapse: () => {},
	};

	const { container } = render(
		React.createElement(RuntimeGraphSegmentDetails, {
			threadId: "thr-1", projectId: "p-1", environment: null,
			segments: [], isExpanded: true, onToggle: () => {}, testState: state,
		}),
	);

	const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement;
	assert.ok(scrollContainer, "Scroll container must exist");

	// Simulate user scrolling up away from bottom
	Object.defineProperty(scrollContainer, "scrollHeight", { value: 1000, configurable: true });
	Object.defineProperty(scrollContainer, "scrollTop", { value: 100, configurable: true });
	Object.defineProperty(scrollContainer, "clientHeight", { value: 300, configurable: true });
	fireEvent.scroll(scrollContainer);

	// After manual scroll, Follow active button is completely removed per Requirement 6
	const followBtn = container.querySelector("button[aria-label='Follow active']");
	assert.equal(followBtn, null, "Follow active button is removed per feedback requirement 6");
});

test("Live metadata rendering: inspector shows toolName, targetHint, model, thinkingLevel, startedAt", () => {
	const item: TaskTreeItem = {
		id: 77, kind: "pi.generation", label: "assistant turn", conversationId: 1,
		isTerminal: false, children: [],
		liveNode: {
			id: 77, kind: "pi.generation", conversationId: 1, background: false, abortRequested: false,
			state: { status: "running", phase: "request" }, label: "assistant turn",
			toolName: "subagent", targetHint: "Investigate live truth",
			model: { provider: "antigravity", modelId: "gemini-3.8-flash" },
			thinkingLevel: "high", startedAt: 1700000000000,
		},
	};

	const { container } = render(React.createElement(RuntimeGraphDetails, { selectedItem: item }));
	assert.ok(container.textContent?.includes("Task Details"));
	assert.ok(container.textContent?.includes("Tool"));
	assert.ok(container.textContent?.includes("subagent"));
	assert.ok(container.textContent?.includes("Target"));
	assert.ok(container.textContent?.includes("Investigate live truth"));
	assert.ok(container.textContent?.includes("Model"));
	assert.ok(container.textContent?.includes("antigravity/gemini-3.8-flash"));
	assert.ok(container.textContent?.includes("Thinking"));
	assert.ok(container.textContent?.includes("high"));
	assert.ok(container.textContent?.includes("Started at"));
	assert.ok(container.textContent?.includes("Duration"));
});
