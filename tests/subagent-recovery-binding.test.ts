import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DurableBindingManager } from "../src/host/durable-binding-store.ts";
import { SessionRegistry } from "../src/host/session-registry.ts";
import type { OwnedSessionPort } from "../src/host/session-port.ts";

function createTmpDir(prefix: string): string {
	const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

test("DurableBindingManager: writes and reads explicit adapter-bindings.json manifest", () => {
	const dir = createTmpDir("binding-manifest-test");
	try {
		const manager = new DurableBindingManager();
		manager.setSessionDir(dir);
		manager.register("thr_child_1", 21848, "thr_parent_root");

		const offline = manager.readOfflineBindings(dir);
		assert.equal(offline.length, 1);
		assert.equal(offline[0].bbThreadId, "thr_child_1");
		assert.equal(offline[0].conversationId, "21848");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("SessionRegistry: child arriving before parent boots parent and binds child", async () => {
	const dir = createTmpDir("child-before-parent-test");
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	try {
		const manifestFile = join(dir, "adapter-bindings.json");
		writeFileSync(manifestFile, JSON.stringify([
			{ bbThreadId: "thr_child_cold", conversationId: "26015", parentThreadId: "thr_parent_main" },
		]), "utf8");

		let parentStarted = false;
		const mockSession: OwnedSessionPort = {
			options: {
				threadId: "thr_parent_main",
				providerThreadId: "pi_durable_parent_test",
				cwd: dir,
				scratchDir: dir,
			},
			runner: { exited: false, requestOk: async () => ({}) },
			async start() { parentStarted = true; },
			async closeGracefully() {},
			kill() {},
			unregisterThread() {},
			async prompt() {},
			async steer() {},
			async abort() {},
			async compact() {},
			async refreshContextUsage() {},
			getLastCheckpointId: () => null,
			registerThread: () => true,
			getConversationIdForThread: (tid: string) => (tid === "thr_child_cold" ? "26015" : undefined),
			getSubagentState: () => undefined,
			findSubagentConversationForTask: () => undefined,
			getMirrorOutputText: () => "",
			markInitialMirrorTurnConsumed() {},
			consumeCompletedMirror() {},
			async setModel() {},
			async setThinkingLevel() {},
			async setSubagentPolicy() {},
			getAcknowledgedSubagentPolicyRevision: () => undefined,
		};

		const registry = new SessionRegistry(
			(method, params) => { notifications.push({ method, params }); },
			() => mockSession,
		);

		const childSession = await registry.createOrGet("thr_child_cold", "pi_durable_parent_test:26015", {
			parentThreadId: "thr_parent_main",
			options: { cwd: dir },
		});

		assert.equal(parentStarted, true, "Parent session must be started first via sole owner admission");
		assert.equal(childSession, mockSession, "Child must be attached to the parent session");
		assert.ok(
			notifications.some((n) => n.method === "thread/identity" && n.params.threadId === "thr_child_cold"),
			"Must emit thread/identity for the child thread",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("SessionRegistry: child with unresolved identity fails closed, never creates standalone root", async () => {
	const dir = createTmpDir("child-fail-closed-test");
	try {
		const mockSession: OwnedSessionPort = {
			options: {
				threadId: "thr_parent_only",
				providerThreadId: "pi_durable_parent_unresolved",
				cwd: dir,
			},
			runner: { exited: false, requestOk: async () => ({}) },
			async start() {},
			async closeGracefully() {},
			kill() {},
			unregisterThread() {},
			async prompt() {},
			async steer() {},
			async abort() {},
			async compact() {},
			async refreshContextUsage() {},
			getLastCheckpointId: () => null,
			registerThread: () => false,
			getConversationIdForThread: () => undefined,
			getSubagentState: () => undefined,
			findSubagentConversationForTask: () => undefined,
			getMirrorOutputText: () => "",
			markInitialMirrorTurnConsumed() {},
			consumeCompletedMirror() {},
			async setModel() {},
			async setThinkingLevel() {},
			async setSubagentPolicy() {},
			getAcknowledgedSubagentPolicyRevision: () => undefined,
		};

		const registry = new SessionRegistry(
			() => {},
			() => mockSession,
		);

		await assert.rejects(
			async () => {
				await registry.createOrGet("thr_child_unknown", "pi_durable_parent_unresolved", {
					parentThreadId: "thr_parent_only",
				});
			},
			(err: Error) => {
				assert.match(err.message, /Cannot resolve|Unresolved parent owner thread/i);
				return true;
			},
			"Child with ambiguous identity must fail closed, never become standalone root",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
