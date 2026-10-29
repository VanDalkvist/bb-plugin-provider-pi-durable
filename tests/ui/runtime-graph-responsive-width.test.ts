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

test.afterEach(() => {
	cleanup();
});

function makeTask(
	id: number, kind: string, label: string, isTerminal = true,
	children: TaskTreeItem[] = [], toolName?: string, targetHint?: string,
): TaskTreeItem {
	return {
		id, kind, label, conversationId: 1, isTerminal, children,
		receipt: isTerminal ? {
			taskId: id, conversationId: 1, kind, outcome: "completed", isToolError: false,
			toolName, targetHint, endedAt: 2000 + id, durationMs: 120,
		} : undefined,
		liveNode: !isTerminal ? {
			id, kind, conversationId: 1, background: false, abortRequested: false,
			state: { status: "running" }, label, toolName, targetHint, startedAt: 1000,
		} : undefined,
	};
}

test("Cycle 92: Leaf task row and breadcrumb child use min-w-0 without artificial max-w pixel ceilings", () => {
	const longPath = "/Users/vanya/Projects/pi-workflow-lab/src/workflows/sensors/long-named-sensor-runner.ts";
	const toolLeaf = makeTask(10, "pi.tool", `read: ${longPath}`, true, [], "read", longPath);
	const toolChild = makeTask(12, "pi.tool", `read: ${longPath}`, true, [], "read", longPath);
	const generation = makeTask(11, "pi.generation", "pi.generation #11", true, [toolChild]);

	const { container } = render(
		React.createElement(RuntimeGraphTree, {
			tree: [toolLeaf, generation],
			selectedTaskId: null,
			collapsedTaskIds: new Set(),
			onSelectTask: () => {},
			onToggleCollapse: () => {},
		}),
	);

	// Verify absence of hardcoded pixel ceilings
	const allElements = container.querySelectorAll("*");
	for (const el of allElements) {
		const cls = el.getAttribute("class") || "";
		assert.equal(cls.includes("max-w-[220px]"), false, "Must NOT contain artificial max-w-[220px]");
		assert.equal(cls.includes("max-w-[170px]"), false, "Must NOT contain artificial max-w-[170px]");
	}

	// Verify child span in breadcrumb has min-w-0
	const breadcrumbChildSpan = container.querySelector("[data-task-id='12']");
	assert.ok(breadcrumbChildSpan, "Breadcrumb child span must exist");
	assert.ok(breadcrumbChildSpan.className.includes("min-w-0"), "Breadcrumb child span must have min-w-0 class for fluid expansion");

	// Verify leaf row label has min-w-0
	const leafSpan = container.querySelector("span[title*='long-named-sensor-runner']");
	assert.ok(leafSpan, "Leaf span with title must exist");
	assert.ok(leafSpan.className.includes("min-w-0"), "Leaf span must have min-w-0 class for fluid expansion");
});

test("Cycle 93: sanitizeTargetHint preserves targetHint up to 128 characters (no premature 48-char cutoff)", async () => {
	const { sanitizeTargetHint } = await import("../../src/runner/task-labels.ts");
	const path86 = "/Users/vanya/Projects/arch-rules-skills/skills/arch-rules-implementation-review/SKILL.md";
	const hint = sanitizeTargetHint(path86);
	assert.equal(hint, path86, "Target path up to 128 characters must be preserved without 48-char clipping");
});

test("Cycle 93: Waiting turn strips ' · waiting on N' suffix and breadcrumb parent has wider max-w", () => {
	const waitingTurn = makeTask(20, "pi.generation", "assistant turn · gpt-6.1-sol (high) · waiting on 7", false);
	const toolChild = makeTask(21, "pi.tool", "read: foo.ts", true);
	waitingTurn.children = [toolChild];

	const { container } = render(
		React.createElement(RuntimeGraphTree, {
			tree: [waitingTurn],
			selectedTaskId: null,
			collapsedTaskIds: new Set(),
			onSelectTask: () => {},
			onToggleCollapse: () => {},
		}),
	);

	// Verify parent span title and text do NOT contain "waiting on"
	const parentSpan = container.querySelector("span[title*='assistant turn']");
	assert.ok(parentSpan, "Parent span must exist");
	assert.equal(parentSpan.textContent?.includes("waiting on"), false, "Must strip redundant 'waiting on' suffix from title");
	assert.ok(parentSpan.className.includes("max-w-[280px]"), "Parent span must use expanded max-w-[280px] width");
});
