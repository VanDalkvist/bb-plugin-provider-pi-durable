import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRunnerControlChannel } from "../src/runner/control-channel.ts";
import type { Harness, TaskId } from "../src/runner/runtime-types.ts";

test("Cycle 95: startRunnerControlChannel processes abort_task from control.jsonl", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-control-test-"));
	const abortedIds: number[] = [];

	const mockHarness = {
		abortTask: async (taskId: TaskId) => {
			abortedIds.push(Number(taskId));
			return "marked" as const;
		},
	} as unknown as Harness;

	const controller = startRunnerControlChannel(tempDir, mockHarness);

	try {
		const controlFile = join(tempDir, "control.jsonl");
		appendFileSync(controlFile, JSON.stringify({ type: "abort_task", taskId: 88 }) + "\n", "utf8");

		// Allow filesystem event to deliver
		for (let i = 0; i < 20; i++) {
			if (abortedIds.includes(88)) break;
			await new Promise((r) => setTimeout(r, 50));
		}

		assert.deepEqual(abortedIds, [88]);
	} finally {
		controller.close();
		rmSync(tempDir, { recursive: true, force: true });
	}
});
