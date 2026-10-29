import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { SessionRegistry } from "../src/host/session-registry.ts";
import { sessionFixture } from "./fixtures/mirror.ts";

test("createOrGet creates independent session for ordinary child thread even when parent_thread_id is in DB", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "bb-test-ordinary-child-db-"));
	const dbPath = join(tempDir, "bb.db");
	const db = new DatabaseSync(dbPath, { open: true });
	db.exec(`
		CREATE TABLE threads (
			id text PRIMARY KEY,
			project_id text,
			environment_id text,
			parent_thread_id text,
			startup_context text
		);
		INSERT INTO threads (id, project_id, environment_id, parent_thread_id, startup_context)
		VALUES (
			'thr_child_ordinary',
			'proj_1',
			'env_1',
			'thr_parent_main',
			json_object('kind', 'dispatched', 'request', json_object('input', json_array(json_object('type', 'text', 'text', 'Independent ordinary task'))))
		);
	`);
	db.close();

	const origDataDir = process.env.BB_DATA_DIR;
	process.env.BB_DATA_DIR = tempDir;
	try {
		const mockParentSession = sessionFixture({
			runner: { exited: false },
			options: {
				threadId: "thr_parent_main",
				providerThreadId: "pi_durable_parent_main_100",
			},
			getConversationIdForThread: () => undefined,
			getSubagentState: () => undefined,
		});

		const mockChildSession = sessionFixture({
			runner: { exited: false },
			options: {
				threadId: "thr_child_ordinary",
				providerThreadId: "pi_durable_random_child_independent_600",
			},
		});

		const registry = new SessionRegistry(
			() => {},
			(opts) => {
				assert.equal(opts.threadId, "thr_child_ordinary");
				return mockChildSession;
			},
		);
		registry.track("thr_parent_main", mockParentSession);

		const session = await registry.createOrGet("thr_child_ordinary", "pi_durable_random_child_independent_600", {
			cwd: "/test",
		});

		assert.equal(session, mockChildSession, "Ordinary child must get its own independent session");
		assert.notEqual(session, mockParentSession, "Ordinary child must NOT be captured by parent session");
		assert.equal(registry.get("thr_child_ordinary"), mockChildSession);
	} finally {
		if (origDataDir !== undefined) {
			process.env.BB_DATA_DIR = origDataDir;
		} else {
			delete process.env.BB_DATA_DIR;
		}
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("createOrGet does not hijack ordinary child with identical task text when envelope is absent", async () => {
	const mockParentSession = sessionFixture({
		runner: { exited: false },
		options: {
			threadId: "thr_parent_same_task",
			providerThreadId: "pi_durable_parent_same_100",
		},
		getConversationIdForThread: () => undefined,
		getSubagentState: (id: string) => (id === "conv_sub_arch" ? { status: "running", task: "Analyze architecture" } : undefined),
	});

	const mockChildSession = sessionFixture({
		runner: { exited: false },
		options: {
			threadId: "thr_ordinary_same_task",
			providerThreadId: "pi_durable_ordinary_same_200",
		},
	});

	const registry = new SessionRegistry(
		() => {},
		(opts) => {
			assert.equal(opts.threadId, "thr_ordinary_same_task");
			return mockChildSession;
		},
	);
	registry.track("thr_parent_same_task", mockParentSession);

	const session = await registry.createOrGet("thr_ordinary_same_task", "pi_durable_ordinary_same_200", {
		parentThreadId: "thr_parent_same_task",
		prompt: "Analyze architecture",
		cwd: "/test",
	});

	assert.equal(session, mockChildSession, "Ordinary child with same task must stay independent");
	assert.notEqual(session, mockParentSession, "Ordinary child must NOT be hijacked into parent subagent");
});

test("createOrGet attaches subagent mirror using versioned envelope to parent session", async () => {
	const registeredThreads: Array<{ threadId: string; conversationId?: string }> = [];
	const mockParentSession = sessionFixture({
		runner: { exited: false },
		options: {
			threadId: "thr_parent_env",
			providerThreadId: "pi_durable_parent_env_100",
		},
		registerThread: (threadId: string, conversationId?: string) => {
			registeredThreads.push({ threadId, conversationId });
			return false;
		},
		getSubagentState: (id: string) => (id === "99" ? { status: "running", task: "test" } : undefined),
	});

	const registry = new SessionRegistry(
		() => {},
		() => sessionFixture({ runner: { exited: false }, options: { threadId: "dummy" } }),
	);
	registry.track("thr_parent_env", mockParentSession);

	const promptWithEnvelope = "[bb:pi-subagent-mirror:v1 session=pi_durable_parent_env_100 parent=thr_parent_env conv=99]\nRun memory leak test";
	const childSession = await registry.createOrGet("thr_child_env", "pi_durable_random_child_700", {
		parentThreadId: "thr_parent_env",
		prompt: promptWithEnvelope,
		cwd: "/test",
	});

	assert.equal(childSession, mockParentSession, "Mirror thread with envelope must attach to parent session");
	assert.deepEqual(registeredThreads, [{ threadId: "thr_child_env", conversationId: "99" }]);
});
