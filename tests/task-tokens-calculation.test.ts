import test from "node:test";
import assert from "node:assert/strict";
import { buildTaskTree } from "../src/ui/runtime-graph/tree-builder.ts";
import type { RuntimeGraphSnapshot } from "../src/runtime-graph/types.ts";

test("buildTaskTree: tokenDelta is never negative when generation tokens vary across steps", { timeout: 2000 }, () => {
	const snapshot: RuntimeGraphSnapshot = {
		version: 1,
		scope: { rootConversationId: "1", generationNumber: 1, timestamp: Date.now() },
		observation: { tasks: 3, running: 0, waiting: 0, pending: 0, failed: 0, completed: 3 },
		conversations: {
			"1": { id: 1, kind: "root" } as any,
		},
		nodes: {
			"10": { id: 10, conversationId: 1, kind: "pi.generation", state: { status: "terminal" }, tokens: { total: 500, input: 400, output: 100 } } as any,
			"11": { id: 11, conversationId: 1, kind: "pi.generation", state: { status: "terminal" }, tokens: { total: 1200, input: 1000, output: 200 } } as any,
			"12": { id: 12, conversationId: 1, kind: "pi.generation", state: { status: "terminal" }, tokens: { total: 300, input: 250, output: 50 } } as any,
		},
		receipts: [],
		stats: { liveCount: 3, terminalCount: 0, totalCount: 3 },
	};

	const tree = buildTaskTree(snapshot);
	assert.equal(tree.length, 3);

	for (const item of tree) {
		assert.ok(item.tokenDelta !== undefined && item.tokenDelta >= 0, `tokenDelta for task ${item.id} must be non-negative: ${item.tokenDelta}`);
	}
});
