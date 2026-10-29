import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionRegistry } from "../src/host/session-registry.ts";
import { SessionOwnerConflictError, SessionIdentityMismatchError } from "../src/host/session-errors.ts";
import { InvalidSubagentMirrorEnvelopeError } from "../src/shared/subagent-envelope.ts";
import { resolveSessionFilePath } from "../src/host/paths.ts";
import { sessionFixture } from "./fixtures/mirror.ts";

test("createOrGet fails with SessionOwnerConflictError when envelope parent does not match thread parent", async () => {
	const mockParentSession = sessionFixture({
		runner: { exited: false },
		options: {
			threadId: "thr_parent_real",
			providerThreadId: "pi_durable_parent_real_100",
		},
	});

	const registry = new SessionRegistry(
		() => {},
		() => sessionFixture({ runner: { exited: false }, options: { threadId: "dummy" } }),
	);
	registry.track("thr_parent_real", mockParentSession);

	const conflictingPrompt = "[bb:pi-subagent-mirror:v1 session=pi_durable_parent_real_100 parent=thr_parent_FORGED conv=99]\nTask";
	await assert.rejects(
		async () => {
			await registry.createOrGet("thr_child_conflict", "pi_durable_random_child_800", {
				parentThreadId: "thr_parent_real",
				prompt: conflictingPrompt,
				cwd: "/test",
			});
		},
		SessionOwnerConflictError,
	);
});

test("createOrGet fails with SessionOwnerConflictError when envelope conv is unknown in parent session", async () => {
	const mockParentSession = sessionFixture({
		runner: { exited: false },
		options: {
			threadId: "thr_parent_known",
			providerThreadId: "pi_durable_parent_known_100",
		},
		getSubagentState: () => undefined,
		getConversationIdForThread: () => undefined,
	});

	const registry = new SessionRegistry(
		() => {},
		() => sessionFixture({ runner: { exited: false }, options: { threadId: "dummy" } }),
	);
	registry.track("thr_parent_known", mockParentSession);

	const unownedConvPrompt = "[bb:pi-subagent-mirror:v1 session=pi_durable_parent_known_100 parent=thr_parent_known conv=999]\nTask";
	await assert.rejects(
		async () => {
			await registry.createOrGet("thr_child_unowned", "pi_durable_child_rand_850", {
				parentThreadId: "thr_parent_known",
				prompt: unownedConvPrompt,
				cwd: "/test",
			});
		},
		SessionOwnerConflictError,
	);
});

test("createOrGet fails with InvalidSubagentMirrorEnvelopeError for reserved prefix with invalid syntax", async () => {
	const mockSession = sessionFixture({
		runner: { exited: false },
		options: {
			threadId: "thr_child_bad_env",
			providerThreadId: "pi_durable_child_900",
		},
	});
	const registry = new SessionRegistry(
		() => {},
		() => mockSession,
	);

	await assert.rejects(
		async () => {
			await registry.createOrGet("thr_child_bad_env", "pi_durable_child_900", {
				prompt: "[bb:pi-subagent-mirror:v999 session=s parent=p conv=c]\nTask",
			});
		},
		InvalidSubagentMirrorEnvelopeError,
	);
});

test("createOrGet fails with SessionOwnerConflictError when conversation is already bound to another thread", async () => {
	const mockParentSession = sessionFixture({
		runner: { exited: false },
		options: {
			threadId: "thr_parent_stolen",
			providerThreadId: "pi_durable_parent_stolen_100",
		},
		getSubagentState: (id: string) => (id === "88" ? { status: "running", task: "Task" } : undefined),
		getThreadIdForConversation: (id: string) => (id === "88" ? "thr_existing_child" : undefined),
	});

	const registry = new SessionRegistry(
		() => {},
		() => sessionFixture({ runner: { exited: false }, options: { threadId: "dummy" } }),
	);
	registry.track("thr_parent_stolen", mockParentSession);

	const stealPrompt = "[bb:pi-subagent-mirror:v1 session=pi_durable_parent_stolen_100 parent=thr_parent_stolen conv=88]\nTask";
	await assert.rejects(
		async () => {
			await registry.createOrGet("thr_intruder_child", "pi_durable_child_rand_888", {
				parentThreadId: "thr_parent_stolen",
				prompt: stealPrompt,
				cwd: "/test",
			});
		},
		SessionOwnerConflictError,
	);
});

test("stopping parent thread does not cancel or abort concurrent ordinary child thread", async () => {
	let childSessionKilled = false;
	const mockParentSession = sessionFixture({
		runner: { exited: false },
		options: {
			threadId: "thr_parent_stop_test",
			providerThreadId: "pi_durable_parent_stop_100",
		},
	});

	const mockChildSession = sessionFixture({
		runner: { exited: false },
		options: {
			threadId: "thr_ordinary_child_alive",
			providerThreadId: "pi_durable_child_alive_200",
		},
		closeGracefully: async () => {
			childSessionKilled = true;
		},
	});

	const registry = new SessionRegistry(
		() => {},
		(opts) => {
			if (opts.threadId === "thr_ordinary_child_alive") return mockChildSession;
			return mockParentSession;
		},
	);
	registry.track("thr_parent_stop_test", mockParentSession);

	await registry.createOrGet("thr_ordinary_child_alive", "pi_durable_child_alive_200", {
		parentThreadId: "thr_parent_stop_test",
		prompt: "Independent worker task",
		cwd: "/test",
	});

	await registry.stop("thr_parent_stop_test");

	assert.equal(registry.get("thr_ordinary_child_alive"), mockChildSession);
	assert.equal(childSessionKilled, false, "Ordinary child must NOT be closed when parent stops");
});

test("createOrGet fails with SessionOwnerConflictError when wait admission resolves to session with mismatched canonical key", async () => {
	const dir = mkdtempSync(join(tmpdir(), "bb-test-wait-conflict-"));
	try {
		const sessDir = resolveSessionFilePath("pi_durable_admitted_root");
		rmSync(sessDir, { recursive: true, force: true });
		mkdirSync(sessDir, { recursive: true });
		writeFileSync(join(sessDir, "session.sqlite"), "");

		const mockSession = sessionFixture({
			runner: { exited: false },
			options: {
				threadId: "thr_parent_coalesced",
				providerThreadId: "pi_durable_admitted_root",
				cwd: dir,
			},
			getSubagentState: () => ({ status: "running", task: "Task" }),
		});

		const registry = new SessionRegistry(
			() => {},
			() => mockSession,
		);

		const prompt1 = "[bb:pi-subagent-mirror:v1 session=pi_durable_admitted_root parent=thr_parent_coalesced conv=88]\nTask 1";
		const prompt2 = "[bb:pi-subagent-mirror:v1 session=pi_durable_DIFFERENT_session parent=thr_parent_coalesced conv=88]\nTask 2";

		const p1 = registry.createOrGet("thr_child_wait_1", "pi_durable_child_wait_100", {
			parentThreadId: "thr_parent_coalesced",
			prompt: prompt1,
			cwd: dir,
		});

		const p2 = registry.createOrGet("thr_child_wait_2", "pi_durable_child_wait_200", {
			parentThreadId: "thr_parent_coalesced",
			prompt: prompt2,
			cwd: dir,
		});

		const [res1, res2Result] = await Promise.allSettled([p1, p2]);
		assert.equal(res1.status, "fulfilled");
		assert.equal(res2Result.status, "rejected");
		assert.ok(
			(res2Result as PromiseRejectedResult).reason instanceof SessionIdentityMismatchError ||
			(res2Result as PromiseRejectedResult).reason instanceof SessionOwnerConflictError
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
