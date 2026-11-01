import test from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/host/session-registry.ts";

test("SessionRegistry.stop() calls session.abort() when stopping parent thread", { timeout: 3000 }, async () => {
	const registry = new SessionRegistry();
	let abortCalled = false;

	const mockSession: any = {
		options: { threadId: "thr_parent_1" },
		abort: async () => {
			abortCalled = true;
		},
		closeGracefully: async () => {},
		unregisterThread: () => {},
	};

	(registry as any).sessions.set("thr_parent_1", mockSession);

	await registry.stop("thr_parent_1");
	assert.equal(abortCalled, true, "Parent thread stop must trigger session.abort() to cascade-kill subagents");
});

test("SessionRegistry.stop() does not call session.abort() when stopping child mirror thread", { timeout: 3000 }, async () => {
	const registry = new SessionRegistry();
	let abortCalled = false;

	const mockSession: any = {
		options: { threadId: "thr_parent_1" },
		abort: async () => {
			abortCalled = true;
		},
		closeGracefully: async () => {},
		unregisterThread: () => {},
	};

	// Register child thread
	(registry as any).sessions.set("thr_child_2", mockSession);

	await registry.stop("thr_child_2");
	assert.equal(abortCalled, false, "Stopping child thread should not abort parent session");
});
