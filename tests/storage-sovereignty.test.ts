import test from "node:test";
import assert from "node:assert/strict";
import { DurableBindingManager } from "../src/host/durable-binding-store.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync, readFileSync } from "node:fs";

test("DurableBindingManager: stores, unregisters, and recovers bindings strictly via host sidecar without raw SQL", () => {
	const sessionDir = join(tmpdir(), `test-sidecar-${Date.now()}`);
	mkdirSync(sessionDir, { recursive: true });

	const manager = new DurableBindingManager();
	manager.setSessionDir(sessionDir);

	// Register bindings
	manager.register("thr_child_1", "2", "thr_parent");
	manager.register("thr_child_2", "3", "thr_parent");

	// Verify bindings persist to adapter-bindings.json sidecar
	const sidecarPath = join(sessionDir, "adapter-bindings.json");
	assert.ok(existsSync(sidecarPath), "adapter-bindings.json sidecar must exist");

	// Unregister a binding and verify sidecar is updated
	manager.unregister("thr_child_1");
	const sidecarContent = JSON.parse(readFileSync(sidecarPath, "utf8"));
	assert.equal(sidecarContent.length, 1, "Unregister must update adapter-bindings.json");
	assert.equal(sidecarContent[0].threadId, "thr_child_2");

	// Recover via a fresh manager instance without opening session.sqlite
	const reader = new DurableBindingManager();
	const recovered = reader.readOfflineBindings(sessionDir);

	assert.equal(recovered.length, 1);
	assert.equal(recovered[0].threadId, "thr_child_2");
	assert.equal(recovered[0].conversationId, "3");
});
