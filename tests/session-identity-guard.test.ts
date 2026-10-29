import test from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/host/session-registry.ts";
import { SessionIdentityMismatchError } from "../src/host/session-errors.ts";
import { sessionFixture } from "./fixtures/mirror.ts";

test("SessionIdentityGuard: legitimate child attaches to parent with own alias providerThreadId", async () => {
	const sessionParent = sessionFixture({
		options: { threadId: "thr_parent_legit", providerThreadId: "pi_parent_root" },
		getSubagentState: (id: string) => (id === "conv_sub_1" ? { status: "running", task: "..." } : undefined),
	});
	const registry = new SessionRegistry(() => {}, () => sessionParent);
	await registry.createOrGet("thr_parent_legit", "pi_parent_root");

	const childSession = await registry.createOrGet("thr_child_legit", "pi_child_alias_100", {
		parentThreadId: "thr_parent_legit",
		conversationId: "conv_sub_1",
	});

	assert.equal(childSession, sessionParent, "Child must legally attach to parent session");
	assert.equal(registry.get("thr_child_legit"), sessionParent);
	assert.equal(registry.getBoundProviderThreadId?.("thr_child_legit"), "pi_child_alias_100");

	// Subsequent turn on child using its own alias returns existing session
	const turn2Session = await registry.createOrGet("thr_child_legit", "pi_child_alias_100");
	assert.equal(turn2Session, sessionParent);
});

test("SessionIdentityGuard: hostile wrong-root composite providerThreadId throws SessionIdentityMismatchError", async () => {
	const sessionParent = sessionFixture({
		options: { threadId: "thr_parent_hostile", providerThreadId: "pi_parent_root" },
	});
	const registry = new SessionRegistry(() => {}, () => sessionParent);
	await registry.createOrGet("thr_parent_hostile", "pi_parent_root");

	await assert.rejects(
		registry.createOrGet("thr_child_hostile", "pi_other_sess:2", { parentThreadId: "thr_parent_hostile" }),
		(err: unknown) => {
			assert.ok(err instanceof SessionIdentityMismatchError || (err instanceof Error && (err as any).code === "SESSION_IDENTITY_MISMATCH"));
			assert.match((err as Error).message, /SESSION_IDENTITY_MISMATCH: parent thread thr_parent_hostile is bound to pi_parent_root, requested pi_other_sess/);
			return true;
		},
	);

	assert.equal(registry.get("thr_parent_hostile"), sessionParent);
	assert.equal(registry.get("thr_child_hostile"), undefined);
});

test("SessionIdentityGuard: child requesting bare sessionKey of an already active different root throws", async () => {
	const sessionA = sessionFixture({
		options: { threadId: "thr_root_a", providerThreadId: "pi_root_a" },
	});
	const sessionB = sessionFixture({
		options: { threadId: "thr_root_b", providerThreadId: "pi_root_b" },
	});

	const registry = new SessionRegistry(() => {});
	registry.track("thr_root_a", sessionA);
	registry.track("thr_root_b", sessionB);

	// Child claims parent is thr_root_b, but uses sessionKey of thr_root_a
	await assert.rejects(
		registry.createOrGet("thr_child_alien", "pi_root_a", { parentThreadId: "thr_root_b", conversationId: "conv_1" }),
		(err: unknown) => {
			assert.ok(err instanceof SessionIdentityMismatchError || (err instanceof Error && (err as any).code === "SESSION_IDENTITY_MISMATCH"));
			assert.match((err as Error).message, /SESSION_IDENTITY_MISMATCH: parent thread thr_root_b is bound to pi_root_b, requested pi_root_a/);
			return true;
		},
	);
});

test("SessionIdentityGuard: same-thread identity replacement on root thread throws without mutating", async () => {
	const sessionRoot = sessionFixture({
		options: { threadId: "thr_guard_root", providerThreadId: "pi_alpha_sess" },
	});
	const registry = new SessionRegistry(() => {}, () => sessionRoot);
	await registry.createOrGet("thr_guard_root", "pi_alpha_sess");

	await assert.rejects(
		registry.createOrGet("thr_guard_root", "pi_beta_sess"),
		(err: unknown) => {
			assert.ok(err instanceof SessionIdentityMismatchError || (err instanceof Error && (err as any).code === "SESSION_IDENTITY_MISMATCH"));
			assert.match((err as Error).message, /SESSION_IDENTITY_MISMATCH: thread thr_guard_root is bound to pi_alpha_sess, requested pi_beta_sess/);
			return true;
		},
	);

	assert.equal(registry.get("thr_guard_root"), sessionRoot);
});

test("SessionIdentityGuard: attached child thread rejects foreign root sessionKey", async () => {
	const sessionParent = sessionFixture({
		options: { threadId: "thr_p_sub", providerThreadId: "pi_p_root" },
		getSubagentState: (id: string) => (id === "conv_c" ? { status: "running", task: "..." } : undefined),
	});
	const registry = new SessionRegistry(() => {}, () => sessionParent);
	await registry.createOrGet("thr_p_sub", "pi_p_root");
	await registry.createOrGet("thr_c_sub", "pi_c_alias", { parentThreadId: "thr_p_sub", conversationId: "conv_c" });

	await assert.rejects(
		registry.createOrGet("thr_c_sub", "pi_completely_foreign"),
		(err: unknown) => {
			assert.ok(err instanceof SessionIdentityMismatchError || (err instanceof Error && (err as any).code === "SESSION_IDENTITY_MISMATCH"));
			assert.match((err as Error).message, /SESSION_IDENTITY_MISMATCH/);
			return true;
		},
	);
});
