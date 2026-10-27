import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { setupDom } from "../setup-dom.ts";
import { makeTask } from "./runtime-graph-test-fixtures.ts";

setupDom();
const { render } = await import("@testing-library/react");
const { installTestPluginRuntime } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { RuntimeGraphTree } = await import("../../src/ui/runtime-graph/tree.tsx");
const { RuntimeGraphSummary } = await import("../../src/ui/runtime-graph/summary.tsx");

test("Breakdown: disjoint breakdown of hidden tasks with multiple outcomes and tool error no double-count", () => {
	// 1 active + 98 finished (total 99)
	// Hidden count will be 98 - 4 = 94 items
	// Out of 94 hidden: 90 completed, 2 failed (1 has toolError), 1 aborted, 1 faulted
	const active = [makeTask(1, false)];
	const previewFinished = [2, 3, 4, 5].map((id) => makeTask(id, true, "completed"));

	const completed90 = Array.from({ length: 90 }, (_, i) => makeTask(100 + i, true, "completed"));
	const failed1 = makeTask(300, true, "failed", [], true); // has tool error
	const failed2 = makeTask(301, true, "failed", [], false);
	const aborted1 = makeTask(302, true, "aborted");
	const faulted1 = makeTask(303, true, "faulted");

	const tree = [...active, ...previewFinished, ...completed90, failed1, failed2, aborted1, faulted1];

	const { container } = render(
		React.createElement(RuntimeGraphTree, {
			tree,
			selectedTaskId: null,
			collapsedTaskIds: new Set(),
			onSelectTask: () => {},
			onToggleCollapse: () => {},
		}),
	);

	const toggle = container.querySelector("button[data-history-toggle='true']");
	assert.ok(toggle, "See more button must exist");

	// Sum: 90 + 2 + 1 + 1 = 94
	const expected = "See more (90 completed · 2 failed · 1 aborted · 1 faulted)";
	assert.ok(
		toggle?.textContent?.includes(expected),
		`Expected '${expected}', got: ${toggle?.textContent}`,
	);
	assert.equal(toggle?.getAttribute("data-has-failure"), "true");
});

test("Summary spacing: button uses gap-1.5 native pattern and preserves direct child title and count spans", () => {
	const activeState: any = {
		threadId: "thr-1",
		status: "ok",
		snapshot: {
			nodes: { "1": makeTask(1, false).liveNode, "2": makeTask(2, false).liveNode },
			receipts: Array.from({ length: 128 }, (_, i) => makeTask(10 + i, true).receipt),
			stats: { liveCount: 2, terminalCount: 128, totalCount: 130 },
		},
		tree: [],
		selectedTaskId: null,
		selectedItem: null,
		collapsedTaskIds: new Set(),
		selectTask: () => {},
		toggleCollapse: () => {},
	};

	const { container } = render(
		React.createElement(RuntimeGraphSummary, {
			threadId: "thr-1",
			projectId: "p-1",
			environment: null,
			segments: [],
			isExpanded: true,
			onToggle: () => {},
			testState: activeState,
		}),
	);

	const btn = container.querySelector("button");
	assert.ok(btn);
	assert.ok(btn.className.includes("gap-1.5"), `Button should use gap-1.5, got: ${btn.className}`);
	assert.ok(!btn.className.includes("gap-2"), "Button should not use gap-2");

	// Direct child selectors MUST still work
	const title = container.querySelector("button > span.font-semibold");
	assert.ok(title, "button > span.font-semibold must exist");
	assert.ok(title.classList.contains("text-foreground"));

	const countSpan = container.querySelector("button > span[data-summary-count='true']");
	assert.ok(countSpan, "button > span[data-summary-count='true'] must exist");
	assert.ok(countSpan.classList.contains("text-foreground"));
	assert.ok(countSpan.textContent?.includes("2 active of 130"));
});
