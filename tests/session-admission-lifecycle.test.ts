import test from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/host/session-registry.ts";
import { sessionFixture } from "./fixtures/mirror.ts";
import { SessionCreationAbortedError, SessionIdentityMismatchError } from "../src/host/session-errors.ts";

test("Finding 1 (P1): aborted admission rejects waiting Promise with typed error, does NOT resolve with killed runner", async () => {
	let killed = false;
	const mockSession = sessionFixture({
		options: { threadId: "thr_root", providerThreadId: "pi_sess_1" },
		start: async () => {
			await new Promise((r) => setTimeout(r, 40));
		},
		kill: () => {
			killed = true;
			mockSession.runner.exited = true;
		},
	});

	const registry = new SessionRegistry(() => {}, () => mockSession);

	const rootPromise = registry.createOrGet("thr_root", "pi_sess_1");
	const waiterPromise = registry.createOrGet("thr_waiter", "pi_sess_1:2", { parentThreadId: "thr_root" });

	const rootRejection = assert.rejects(rootPromise, (err: unknown) => {
		assert.ok(err instanceof Error);
		assert.match(err.message, /SESSION_CREATION_ABORTED/);
		return true;
	});
	const waiterRejection = assert.rejects(waiterPromise, (err: unknown) => {
		assert.ok(err instanceof Error);
		assert.match(err.message, /SESSION_CREATION_ABORTED/);
		return true;
	});

	await new Promise((r) => setTimeout(r, 5));
	await registry.stop("thr_root");

	assert.equal(killed, true, "Session must be killed when root is aborted");
	await Promise.all([rootRejection, waiterRejection]);

	assert.equal(registry.get("thr_root"), undefined);
	assert.equal(registry.get("thr_waiter"), undefined);
});

test("Finding 2A (P1): stop child waiter cancels wait, does not attach later, does not affect root or other child waiters", async () => {
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	const boundThreads: string[] = [];

	const mockSession = sessionFixture({
		options: { threadId: "thr_root", providerThreadId: "pi_sess_2" },
		start: async () => {
			await new Promise((r) => setTimeout(r, 40));
		},
		registerThread: (threadId: string) => {
			boundThreads.push(threadId);
			return false;
		},
	});

	const registry = new SessionRegistry((method, params) => notifications.push({ method, params }), () => mockSession);

	const rootPromise = registry.createOrGet("thr_root", "pi_sess_2");
	const childAPromise = registry.createOrGet("thr_child_a", "pi_sess_2:2", { parentThreadId: "thr_root" });
	const childBPromise = registry.createOrGet("thr_child_b", "pi_sess_2:3", { parentThreadId: "thr_root" });

	const childARejection = assert.rejects(childAPromise, /SESSION_CREATION_ABORTED/);

	await new Promise((r) => setTimeout(r, 5));
	await registry.stop("thr_child_a");
	await childARejection;

	const [rootSession, childBSession] = await Promise.all([rootPromise, childBPromise]);
	assert.equal(rootSession, mockSession);
	assert.equal(childBSession, mockSession);

	assert.equal(registry.get("thr_child_a"), undefined);
	assert.equal(registry.get("thr_child_b"), mockSession);
	assert.equal(registry.get("thr_root"), mockSession);

	const childAIdentities = notifications.filter((n) => n.method === "thread/identity" && n.params.threadId === "thr_child_a");
	assert.equal(childAIdentities.length, 0, "No identity notification should be sent for aborted child A");
});

test("Finding 2B (P1): child initiates creation before root: stop child creator does NOT kill shared root", async () => {
	let killed = false;
	const mockSession = sessionFixture({
		options: { threadId: "thr_root", providerThreadId: "pi_sess_3" },
		start: async () => {
			await new Promise((r) => setTimeout(r, 40));
		},
		kill: () => {
			killed = true;
		},
	});

	const registry = new SessionRegistry(() => {}, () => mockSession);

	const childPromise = registry.createOrGet("thr_child_creator", "pi_sess_3:2", { parentThreadId: "thr_root" });
	const rootPromise = registry.createOrGet("thr_root", "pi_sess_3");

	const childRejection = assert.rejects(childPromise, /SESSION_CREATION_ABORTED/);

	await new Promise((r) => setTimeout(r, 5));
	await registry.stop("thr_child_creator");
	await childRejection;

	const rootSession = await rootPromise;
	assert.equal(killed, false, "Shared root session must NOT be killed when child creator stops");
	assert.equal(rootSession, mockSession);
	assert.equal(registry.get("thr_root"), mockSession);
	assert.equal(registry.get("thr_child_creator"), undefined);
});

test("Finding 2C (P1): dispose/stopAll rejects all affected requests with safe typed error and does not return killed runner", async () => {
	let killed = false;
	const mockSession = sessionFixture({
		options: { threadId: "thr_root", providerThreadId: "pi_sess_4" },
		start: async () => {
			await new Promise((r) => setTimeout(r, 40));
		},
		kill: () => {
			killed = true;
			mockSession.runner.exited = true;
		},
	});

	const registry = new SessionRegistry(() => {}, () => mockSession);

	const rootPromise = registry.createOrGet("thr_root", "pi_sess_4");
	const childPromise = registry.createOrGet("thr_child_waiter", "pi_sess_4:2", { parentThreadId: "thr_root" });

	const rootRejection = assert.rejects(rootPromise, (err: unknown) => {
		assert.ok(err instanceof Error);
		assert.match(err.message, /SESSION_CREATION_ABORTED/);
		return true;
	});
	const childRejection = assert.rejects(childPromise, (err: unknown) => {
		assert.ok(err instanceof Error);
		assert.match(err.message, /SESSION_CREATION_ABORTED/);
		return true;
	});

	await new Promise((r) => setTimeout(r, 5));
	await registry.stopAll();

	assert.equal(killed, true);
	await Promise.all([rootRejection, childRejection]);
});

test("Finding 3A (P2): same threadId returns existing only when sessionKey matches; mismatch throws typed error without mutating binding", async () => {
	const sessionAlpha = sessionFixture({
		options: { threadId: "thr_reuse", providerThreadId: "pi_alpha" },
	});

	const registry = new SessionRegistry(() => {}, () => sessionAlpha);

	const created = await registry.createOrGet("thr_reuse", "pi_alpha");
	assert.equal(created, sessionAlpha);

	await assert.rejects(
		registry.createOrGet("thr_reuse", "pi_beta"),
		(err: unknown) => {
			assert.ok(err instanceof SessionIdentityMismatchError || (err instanceof Error && (err as any).code === "SESSION_IDENTITY_MISMATCH"));
			assert.match((err as Error).message, /SESSION_IDENTITY_MISMATCH/);
			return true;
		},
	);

	assert.equal(registry.get("thr_reuse"), sessionAlpha);
});

test("Finding 3B (P2): child requesting parentThreadId with mismatched sessionKey throws typed error and does not mutate parent", async () => {
	const sessionParent = sessionFixture({
		options: { threadId: "thr_p", providerThreadId: "pi_parent_sess" },
	});

	const registry = new SessionRegistry(() => {}, () => sessionParent);

	await registry.createOrGet("thr_p", "pi_parent_sess");

	await assert.rejects(
		registry.createOrGet("thr_c", "pi_different_sess:2", { parentThreadId: "thr_p" }),
		(err: unknown) => {
			assert.ok(err instanceof SessionIdentityMismatchError || (err instanceof Error && (err as any).code === "SESSION_IDENTITY_MISMATCH"));
			assert.match((err as Error).message, /SESSION_IDENTITY_MISMATCH/);
			return true;
		},
	);

	assert.equal(registry.get("thr_p"), sessionParent);
	assert.equal(registry.get("thr_c"), undefined);
});
