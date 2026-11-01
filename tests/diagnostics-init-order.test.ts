import test from "node:test";
import assert from "node:assert/strict";
import { TaskNames } from "../src/runner/task-labels.ts";

test("TaskNames: limits internal cache to 512 entries without unbounded memory leak", { timeout: 3000 }, () => {
	const names = new TaskNames();

	for (let i = 0; i < 600; i++) {
		const mockView: any = {
			conversation: {
				docs: {
					"pi.live": {
						tools: [{ taskId: i, name: `tool_${i}`, callId: `call_${i}` }],
					},
				},
			},
		};
		names.learn(mockView);
	}

	// Oldest task (0) must be evicted to prevent unbounded memory leak
	assert.equal(names.get("0"), undefined, "Task 0 should have been evicted by LRU/FIFO policy");
	// Newest task (599) must be present
	assert.ok(names.get("599"), "Newest task 599 must be present in TaskNames");
});
