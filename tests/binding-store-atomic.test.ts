import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableBindingManager } from "../src/host/durable-binding-store.ts";

test("DurableBindingManager: writes adapter-bindings.json atomically without temp file residue", { timeout: 2000 }, () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-binding-atomic-"));
	try {
		const manager = new DurableBindingManager();
		manager.setSessionDir(tempDir);

		manager.register("thr_child_1", 2, "thr_parent");
		manager.register("thr_child_2", 3, "thr_parent");

		const manifestPath = join(tempDir, "adapter-bindings.json");
		assert.ok(existsSync(manifestPath), "Manifest must exist");

		// Verify no dangling temp files
		const files = readdirSync(tempDir);
		const tempFiles = files.filter((f) => f.includes(".tmp."));
		assert.equal(tempFiles.length, 0, "No temp files should remain after atomic rename");

		// Verify contents
		const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
		assert.equal(parsed.length, 2);
		assert.equal(manager.getThreadId(2), "thr_child_1");
		assert.equal(manager.getThreadId(3), "thr_child_2");

		manager.unregister("thr_child_1");
		const updated = JSON.parse(readFileSync(manifestPath, "utf8"));
		assert.equal(updated.length, 1);
		assert.equal(updated[0].threadId, "thr_child_2");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});
