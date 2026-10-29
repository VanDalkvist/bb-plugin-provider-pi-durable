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
import { sessionFixture } from "./fixtures/mirror.ts";

test("createOrGet reuses existing parent PiThreadSession when params.parentThreadId is provided", async () => {
    const notifications: Array<{
        method: string;
        params: Record<string, unknown>;
    }> = [];
    const registeredThreads: Array<{
        threadId: string;
        conversationId?: string;
    }> = [];
    const mockParentSession = sessionFixture({
        runner: { exited: false },
        options: {
            threadId: "thr_parent",
            providerThreadId: "pi_durable_parent_100",
        },
        registerThread: (threadId: string, conversationId?: string) => {
            registeredThreads.push({ threadId, conversationId });
            return false;
        },
        findSubagentConversationForTask: () => undefined,
        getSubagentState: () => undefined,
    });
    const registry = new SessionRegistry((method, params) => {
        notifications.push({ method, params });
    });
    // Register parent session
    registry.track("thr_parent", mockParentSession);
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
			parent_thread_id text,
			startup_context text
		);
		INSERT INTO threads (id, project_id, environment_id, parent_thread_id)
		VALUES ('thr_child_from_db', 'proj_1', 'env_1', 'thr_parent_db');
	`);
    db.close();
    const origDataDir = process.env.BB_DATA_DIR;
    process.env.BB_DATA_DIR = tempDir;
    try {
        const notifications: Array<{
            method: string;
            params: Record<string, unknown>;
        }> = [];
        const registeredThreads: Array<{
            threadId: string;
            conversationId?: string;
        }> = [];
        const mockParentSession = sessionFixture({
            runner: { exited: false },
            options: {
                threadId: "thr_parent_db",
                providerThreadId: "pi_durable_parent_db_100",
            },
            registerThread: (threadId: string, conversationId?: string) => {
                registeredThreads.push({ threadId, conversationId });
                return false;
            },
            findSubagentConversationForTask: () => undefined,
            getSubagentState: () => undefined,
        });
        const registry = new SessionRegistry((method, params) => {
            notifications.push({ method, params });
        });
        registry.track("thr_parent_db", mockParentSession);
        // Child thread connects with NO parentThreadId in params, but it exists in bb.db
        const childSession = await registry.createOrGet("thr_child_from_db", "pi_durable_random_child_300", {
            conversationId: "conv_sub_from_db",
            cwd: "/test",
        });
        assert.equal(childSession, mockParentSession, "Must reuse parent session resolved from bb.db");
        assert.equal(registry.get("thr_child_from_db"), mockParentSession);
        assert.deepEqual(registeredThreads, [{ threadId: "thr_child_from_db", conversationId: "conv_sub_from_db" }]);
    }
    finally {
        if (origDataDir !== undefined) {
            process.env.BB_DATA_DIR = origDataDir;
        }
        else {
            delete process.env.BB_DATA_DIR;
        }
        rmSync(tempDir, { recursive: true, force: true });
    }
});

test("createOrGet resolves targetConversationId from task prompt via findSubagentConversationForTask", async () => {
    const registeredThreads: Array<{
        threadId: string;
        conversationId?: string;
    }> = [];
    const mockParentSession = sessionFixture({
        runner: { exited: false },
        options: {
            threadId: "thr_parent",
            providerThreadId: "pi_durable_parent_100",
        },
        registerThread: (threadId: string, conversationId?: string) => {
            registeredThreads.push({ threadId, conversationId });
            return false;
        },
        findSubagentConversationForTask: (task: string) => {
            return task === "Perform security audit" ? "conv_sub_security" : undefined;
        },
        getSubagentState: () => undefined,
    });
    const registry = new SessionRegistry(() => { });
    registry.track("thr_parent", mockParentSession);
    const childSession = await registry.createOrGet("thr_child_task", "pi_durable_random_child_400", {
        parentThreadId: "thr_parent",
        task: "Perform security audit",
        cwd: "/test",
    });
    assert.equal(childSession, mockParentSession);
    assert.deepEqual(registeredThreads, [{ threadId: "thr_child_task", conversationId: "conv_sub_security" }]);
});

test("createOrGet recovers targetConversationId and reuses parent session when thread/start arrives BEFORE CLI finishes", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bb-test-race-db-"));
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
			'thr_child_race',
			'proj_1',
			'env_1',
			'thr_parent_race',
			json_object('kind', 'dispatched', 'request', json_object('input', json_array(json_object('type', 'text', 'text', 'Perform live security audit'))))
		);
	`);
    db.close();

    const origDataDir = process.env.BB_DATA_DIR;
    process.env.BB_DATA_DIR = tempDir;
    try {
        const registeredThreads: Array<{ threadId: string; conversationId?: string }> = [];
        const mockParentSession = sessionFixture({
            runner: { exited: false },
            options: {
                threadId: "thr_parent_race",
                providerThreadId: "pi_durable_parent_race_100",
            },
            registerThread: (threadId: string, conversationId?: string) => {
                registeredThreads.push({ threadId, conversationId });
                return false;
            },
            getConversationIdForThread: (_threadId: string) => {
                // CLI has NOT completed yet! So memory map does NOT have thr_child_race!
                return undefined;
            },
            findSubagentConversationForTask: (task: string) => {
                return task === "Perform live security audit" ? "conv_sub_security_race" : undefined;
            },
            getSubagentState: () => undefined,
        });

        const registry = new SessionRegistry(() => {});
        registry.track("thr_parent_race", mockParentSession);

        // Real BB thread/start payload: NO parentThreadId, NO task, NO conversationId, NO input!
        const childSession = await registry.createOrGet("thr_child_race", "pi_durable_random_child_race_500", {
            cwd: "/test",
        });

        assert.equal(childSession, mockParentSession, "Must attach to parent session");
        assert.deepEqual(registeredThreads, [{ threadId: "thr_child_race", conversationId: "conv_sub_security_race" }]);
    } finally {
        if (origDataDir !== undefined) {
            process.env.BB_DATA_DIR = origDataDir;
        } else {
            delete process.env.BB_DATA_DIR;
        }
        rmSync(tempDir, { recursive: true, force: true });
    }
});

test("createOrGet fails closed when startup_context task cannot be matched to any pending subagent", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bb-test-mismatch-db-"));
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
			'thr_child_mismatch',
			'proj_1',
			'env_1',
			'thr_parent_mismatch',
			json_object('kind', 'dispatched', 'request', json_object('input', json_array(json_object('type', 'text', 'text', 'Unrelated foreign task'))))
		);
	`);
    db.close();

    const origDataDir = process.env.BB_DATA_DIR;
    process.env.BB_DATA_DIR = tempDir;
    try {
        const mockParentSession = sessionFixture({
            runner: { exited: false },
            options: {
                threadId: "thr_parent_mismatch",
                providerThreadId: "pi_durable_parent_mismatch_100",
            },
            getConversationIdForThread: (_threadId: string) => undefined,
            findSubagentConversationForTask: (_task: string) => undefined,
            getSubagentState: () => undefined,
        });

        const registry = new SessionRegistry(() => {});
        registry.track("thr_parent_mismatch", mockParentSession);

        await assert.rejects(
            async () => {
                await registry.createOrGet("thr_child_mismatch", "pi_durable_random_child_mismatch_600", {
                    cwd: "/test",
                });
            },
            /Cannot resolve native child conversation for thread thr_child_mismatch under parent thr_parent_mismatch/
        );
    } finally {
        if (origDataDir !== undefined) {
            process.env.BB_DATA_DIR = origDataDir;
        } else {
            delete process.env.BB_DATA_DIR;
        }
        rmSync(tempDir, { recursive: true, force: true });
    }
});

