import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolItemReconciler } from "../src/host/tool-item-reconciler.ts";
import type { ThreadDelta } from "../src/host/types.ts";

function createTmpDir(prefix: string): string {
	const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

test("ToolItemReconciler: tracks opened items and closes cleanly on completion", () => {
	const dir = createTmpDir("reconciler-clean-test");
	try {
		const reconciler = new ToolItemReconciler(dir);
		reconciler.recordOpen("thr_1", "item_123", "bash", { command: "npm test" });

		assert.equal(reconciler.getOpenItems("thr_1").length, 1);
		assert.equal(reconciler.getOpenItems("thr_1")[0].providerItemId, "item_123");

		reconciler.recordClose("thr_1", "item_123");
		assert.equal(reconciler.getOpenItems("thr_1").length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("ToolItemReconciler: reconciles crash/interruption to failed status truthfully, never success", () => {
	const dir = createTmpDir("reconciler-crash-test");
	try {
		// 1. Simulate process 1 recording an active tool item before dying
		const r1 = new ToolItemReconciler(dir);
		r1.recordOpen("thr_1", "dae12f14b4-i168", "bash", { command: "npx tsx --test foo.test.ts" });

		// 2. Simulate process 2 restarting from the same session dir
		const r2 = new ToolItemReconciler(dir);
		const emittedDeltas: ThreadDelta[] = [];
		const closed = r2.reconcileInterruptedItems("thr_1", (delta) => emittedDeltas.push(delta));

		assert.equal(closed.length, 1);
		assert.equal(closed[0], "dae12f14b4-i168");
		assert.equal(emittedDeltas.length, 1);
		const closeDelta = emittedDeltas[0];
		assert.equal(closeDelta.kind, "item.close");
		assert.equal(closeDelta.key?.providerItemId, "dae12f14b4-i168");
		assert.equal(closeDelta.status, "failed");
		assert.match(String(closeDelta.resultText || closeDelta.error?.message), /interrupted/i);

		// Subsequent reconciliation finds no remaining open items
		const secondPass: ThreadDelta[] = [];
		const closed2 = r2.reconcileInterruptedItems("thr_1", (delta) => secondPass.push(delta));
		assert.equal(closed2.length, 0);
		assert.equal(secondPass.length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
