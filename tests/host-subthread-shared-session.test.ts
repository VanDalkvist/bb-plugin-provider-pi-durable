import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { SessionRegistry } from "../src/host/session-registry.ts";
import { handleTurnStart } from "../src/host/bridge-router.ts";
import { PiThreadSession } from "../src/host/session.ts";
import type { RunnerEvent } from "../src/host/types.ts";

test("createOrGet reuses existing parent PiThreadSession when params.parentThreadId is provided", async () => {
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	const registeredThreads: Array<{ threadId: string; conversationId?: string }> = [];

	const mockParentSession = {
		runner: { exited: false },
		options: {
			threadId: "thr_parent",
			providerThreadId: "pi_durable_parent_100",
		},
		registerThread: (threadId: string, conversationId?: string) => {
			registeredThreads.push({ threadId, conversationId });
		},
		findSubagentConversationForTask: () => undefined,
		getSubagentState: () => undefined,
	} as unknown as PiThreadSession;

	const registry = new SessionRegistry((method, params) => {
		notifications.push({ method, params });
	});

	// Register parent session
	(registry as unknown as { sessions: Map<string, PiThreadSession> }).sessions.set("thr_parent", mockParentSession);

	// Child thread connects with fresh random providerThreadId (as BB does) and parentThreadId in params
	const childSession = await registry.createOrGet("thr_child", "pi_durable_random_child_200", {
		parentThreadId: "thr_parent",
		conversationId: "conv_sub_1",
		cwd: "/test",
	});

	// Must reuse the exact same parent session instance
	assert.equal(childSession, mockParentSession, "Must reuse parent session for child thread");
	assert.equal(registry.get("thr_child"), mockParentSession);
	assert.deepEqual(registeredThreads, [{ threadId: "thr_child", conversationId: "conv_sub_1" }]);

	// Must have emitted identity and delta reset for child thread
	assert.equal(notifications.length, 2);
	assert.equal(notifications[0].method, "thread/identity");
	assert.equal(notifications[0].params.threadId, "thr_child");
	assert.equal(notifications[0].params.providerThreadId, "pi_durable_random_child_200");
	assert.equal(notifications[1].method, "thread/delta");
	assert.deepEqual(notifications[1].params.deltas, [{ kind: "session.reset" }]);
});

test("createOrGet reuses existing parent PiThreadSession when parent is resolved from DB", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "bb-test-db-"));
	const dbPath = join(tempDir, "bb.db");
	const db = new DatabaseSync(dbPath, { open: true });
	db.exec(`
		CREATE TABLE threads (
			id text PRIMARY KEY,
			project_id text,
			environment_id text,
			parent_thread_id text
		);
		INSERT INTO threads (id, project_id, environment_id, parent_thread_id)
		VALUES ('thr_child_from_db', 'proj_1', 'env_1', 'thr_parent_db');
	`);
	db.close();

	const origDataDir = process.env.BB_DATA_DIR;
	process.env.BB_DATA_DIR = tempDir;

	try {
		const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
		const registeredThreads: Array<{ threadId: string; conversationId?: string }> = [];

		const mockParentSession = {
			runner: { exited: false },
			options: {
				threadId: "thr_parent_db",
				providerThreadId: "pi_durable_parent_db_100",
			},
			registerThread: (threadId: string, conversationId?: string) => {
				registeredThreads.push({ threadId, conversationId });
			},
			findSubagentConversationForTask: () => undefined,
			getSubagentState: () => undefined,
		} as unknown as PiThreadSession;

		const registry = new SessionRegistry((method, params) => {
			notifications.push({ method, params });
		});

		(registry as unknown as { sessions: Map<string, PiThreadSession> }).sessions.set("thr_parent_db", mockParentSession);

		// Child thread connects with NO parentThreadId in params, but it exists in bb.db
		const childSession = await registry.createOrGet("thr_child_from_db", "pi_durable_random_child_300", {
			conversationId: "conv_sub_from_db",
			cwd: "/test",
		});

		assert.equal(childSession, mockParentSession, "Must reuse parent session resolved from bb.db");
		assert.equal(registry.get("thr_child_from_db"), mockParentSession);
		assert.deepEqual(registeredThreads, [{ threadId: "thr_child_from_db", conversationId: "conv_sub_from_db" }]);
	} finally {
		if (origDataDir !== undefined) {
			process.env.BB_DATA_DIR = origDataDir;
		} else {
			delete process.env.BB_DATA_DIR;
		}
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("createOrGet resolves targetConversationId from task prompt via findSubagentConversationForTask", async () => {
	const registeredThreads: Array<{ threadId: string; conversationId?: string }> = [];

	const mockParentSession = {
		runner: { exited: false },
		options: {
			threadId: "thr_parent",
			providerThreadId: "pi_durable_parent_100",
		},
		registerThread: (threadId: string, conversationId?: string) => {
			registeredThreads.push({ threadId, conversationId });
		},
		findSubagentConversationForTask: (task: string) => {
			return task === "Perform security audit" ? "conv_sub_security" : undefined;
		},
		getSubagentState: () => undefined,
	} as unknown as PiThreadSession;

	const registry = new SessionRegistry(() => {});
	(registry as unknown as { sessions: Map<string, PiThreadSession> }).sessions.set("thr_parent", mockParentSession);

	const childSession = await registry.createOrGet("thr_child_task", "pi_durable_random_child_400", {
		parentThreadId: "thr_parent",
		task: "Perform security audit",
		cwd: "/test",
	});

	assert.equal(childSession, mockParentSession);
	assert.deepEqual(registeredThreads, [{ threadId: "thr_child_task", conversationId: "conv_sub_security" }]);
});

test("handleTurnStart intercepts running subagent turn on child thread and suppresses duplicate prompt", async () => {
	let promptCalls = 0;
	const registeredThreads: Array<{ threadId: string; conversationId?: string }> = [];
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	const results: Array<{ id: string | number; result: Record<string, unknown> }> = [];

	const mockParentSession = {
		runner: { exited: false },
		options: { threadId: "thr_parent", providerThreadId: "pi_durable_root" },
		prompt: async () => {
			promptCalls++;
		},
		findSubagentConversationForTask: (task: string) => (task === "Run background test" ? "conv_sub_bg" : undefined),
		getSubagentState: (convId: string) => (convId === "conv_sub_bg" ? { status: "running", task: "Run background test" } : undefined),
		registerThread: (threadId: string, conversationId?: string) => {
			registeredThreads.push({ threadId, conversationId });
		},
	} as unknown as PiThreadSession;

	const registry = new SessionRegistry(() => {});
	(registry as unknown as { sessions: Map<string, PiThreadSession> }).sessions.set("thr_parent", mockParentSession);

	const ctx = {
		registry,
		sendNotification: (method: string, params: Record<string, unknown>) => notifications.push({ method, params }),
		sendResult: (id: string | number, result: Record<string, unknown>) => results.push({ id, result }),
		sendError: () => {},
	};

	await handleTurnStart(
		"req_spawn_child_1",
		{
			threadId: "thr_child_spawn",
			providerThreadId: "pi_durable_child_random_500",
			parentThreadId: "thr_parent",
			input: [{ type: "text", text: "Run background test" }],
			clientRequestId: "creq_23456789ab",
		},
		ctx,
	);

	// 1. Duplicate prompt was NOT called
	assert.equal(promptCalls, 0, "session.prompt must not be called for an actively running subagent");

	// 2. Thread was registered with the parent session under the subagent conversationId
	assert.ok(
		registeredThreads.some((r) => r.threadId === "thr_child_spawn" && r.conversationId === "conv_sub_bg"),
		"Child thread must be registered with conversationId",
	);

	// 3. Turn was acknowledged to BB
	assert.equal(results.length, 1);
	assert.equal(results[0].id, "req_spawn_child_1");

	// 4. input.accepted was emitted for the child thread
	const acceptedDelta = notifications.find((n) => n.method === "thread/delta" && n.params.threadId === "thr_child_spawn");
	assert.ok(acceptedDelta, "input.accepted must be emitted for child thread");
});

test("Subagent runner events for registered child thread stream cleanly", async () => {
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];

	const session = new PiThreadSession(
		{
			threadId: "thr_parent",
			providerThreadId: "pi_durable_root",
			sessionFilePath: "/tmp/fake-child-stream.sqlite",
			sessionDir: "/tmp",
			extensionPath: "/tmp/ext",
			scratchDir: "/tmp/scratch",
		},
		(method, params) => notifications.push({ method, params }),
	);

	try {
		session.registerThread("thr_child_stream", "conv_stream_77");
		session.markSubagentActive("conv_stream_77", { task: "Streaming audit", parentToolCallId: "call_sub_77" });

		const childEvent: RunnerEvent = {
			type: "message_update",
			conversationId: "conv_stream_77",
			parentRef: "call_sub_77",
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "Analyzing AST...",
			},
		};

		await (session as any).handleRunnerEvent(childEvent);

		// Child thread must receive delta without parentRef
		const childNotifs = notifications.filter((n) => n.params.threadId === "thr_child_stream");
		assert.ok(childNotifs.length > 0, "Child thread must receive root streaming deltas");
		const childDelta = (childNotifs[0].params.deltas as any[])[0];
		assert.equal(childDelta.key?.parentRef, undefined);

		// Now simulate agent_end
		const agentEndEvent: RunnerEvent = {
			type: "agent_end",
			conversationId: "conv_stream_77",
			parentRef: "call_sub_77",
		};

		await (session as any).handleRunnerEvent(agentEndEvent);

		// Child thread must receive turn.boundary completed
		const childBoundaries = notifications.filter(
			(n) =>
				n.params.threadId === "thr_child_stream" &&
				Array.isArray(n.params.deltas) &&
				(n.params.deltas as any[]).some((d) => d.kind === "turn.boundary" && d.status === "completed"),
		);
		assert.ok(childBoundaries.length > 0, "Child thread must receive completed turn.boundary upon agent_end");
	} finally {
		session.kill();
	}
});
