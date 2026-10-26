import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Harness, createRegistry, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
	BindingDoc,
	BindingIndexDoc,
	identityKey,
	type StoredBinding,
} from "../src/runner/binding-docs.ts";
import { handleBindingCommand } from "../src/runner/binding-commands.ts";
import { DurableBindingManager } from "../src/host/durable-binding-store.ts";
import { PiThreadSession } from "../src/host/session.ts";
import type { SessionOptions } from "../src/host/types.ts";

test("DurableBindingManager.readOfflineBindings: cold offline recovery from SQLite", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-durable-binding-"));
	try {
		const dbPath = join(tempDir, "session.sqlite");
		const db = new DatabaseSync(dbPath);
		db.exec(`
			CREATE TABLE documents (
				id INTEGER PRIMARY KEY,
				kind TEXT NOT NULL,
				family INTEGER,
				key_value TEXT,
				scope_kind TEXT,
				owner_id INTEGER,
				created_at INTEGER,
				retired_at INTEGER,
				record TEXT
			);
			CREATE TABLE document_revisions (
				document_id INTEGER,
				seq INTEGER,
				kind TEXT,
				version INTEGER,
				content TEXT
			);
			INSERT INTO documents VALUES (1, 'bb.native-child-binding', 0, '', 'conversation', 7, 1000, NULL, '{}');
			INSERT INTO document_revisions VALUES (1, 1, 'base', 2, '{"binding":{"bbThreadId":"thr_offline_7","conversationId":7}}');
		`);
		db.close();

		const manager = new DurableBindingManager();
		const bindings = manager.readOfflineBindings(tempDir);
		assert.equal(bindings.length, 1);
		assert.equal(bindings[0].bbThreadId, "thr_offline_7");
		assert.equal(bindings[0].conversationId, "7");

		manager.hydrateFromOffline(tempDir);
		assert.equal(manager.getThreadId(7), "thr_offline_7");
		assert.equal(manager.getConversationId("thr_offline_7"), "7");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("PiThreadSession integration: binds child thread and routes child deltas", async () => {
	const notifications: Array<{ method: string; params: any }> = [];
	const options: SessionOptions = {
		threadId: "thr_parent_root", providerThreadId: "fixture:1", scratchDir: tmpdir(),
		cwd: process.cwd(),
		sessionFilePath: join(tmpdir(), `session-${Date.now()}-binding-test.sqlite`),
		sessionDir: tmpdir(),
		extensionPath: "/tmp/mock-ext.mjs",
	};

	const session = new PiThreadSession(options, (method, params) => {
		notifications.push({ method, params });
	});

	try {
		// Register a child thread to conversation 3
		session.registerThread("thr_child_3", "3");
		assert.equal(session.getThreadIdForConversation(3), "thr_child_3");
		assert.equal(session.bindings.getConversationId("thr_child_3"), "3");

		// Simulate incoming child runner event
		const childEvent: any = {
			type: "message_update",
			conversationId: 3,
			assistantMessageEvent: {
				type: "text_delta",
				delta: "Hello from child subthread!",
			},
		};

		// Call private handleRunnerEvent
		await (session as any).handleRunnerEvent(childEvent);

		// The delta must be routed to thr_child_3!
		const childNotifications = notifications.filter(
			(n) => n.method === "thread/delta" && n.params?.threadId === "thr_child_3",
		);
		assert.ok(childNotifications.length > 0);
		const textDelta = childNotifications[0].params.deltas.find((d: any) => d.kind === "item.textDelta");
		assert.ok(textDelta);
		assert.equal(textDelta.text, "Hello from child subthread!");

		// Unregister thread cleans up both bindings and child translator
		session.unregisterThread("thr_child_3");
		assert.equal(session.getThreadIdForConversation(3), undefined);
		assert.equal(session.bindings.getConversationId("thr_child_3"), undefined);
	} finally {
		session.kill();
	}
});

test("DurableBindingManager: reads offline bindings from real SDK-created SQLite store (Issue #24)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "synthetic-binding-"));
	const path = join(dir, "session.sqlite");
	const binding: StoredBinding = {
		providerId: "pi-durable",
		sessionId: "synthetic-session",
		conversationId: ROOT_CONVERSATION_ID,
		bbThreadId: "synthetic-thread",
		parentThreadId: null,
		createdAt: 1,
	};
	try {
		for (const write of [true, false]) {
			const storage = await openNodeSqliteStorage(path);
			const harness = await Harness.open(
				storage,
				{
					registry: createRegistry(),
					models: createModels(),
				},
				ctx,
			);
			try {
				await harness.root(ctx);
				if (write) {
					await harness.commit(async (tx) => {
						(await tx.doc(BindingDoc, ROOT_CONVERSATION_ID)).binding = binding;
					}, ctx);
				}
				assert.deepEqual(
					(await harness.snapshot(BindingDoc, ROOT_CONVERSATION_ID, ctx))?.binding,
					binding,
				);
			} finally {
				await harness.close(ctx);
				await storage.close(ctx);
			}
		}

		// Verify that SQLite documents table really has JSON-encoded kind
		const db = new DatabaseSync(path, { readOnly: true });
		try {
			const rows = db.prepare("SELECT kind FROM documents WHERE kind LIKE '%native-child%'").all() as Array<{ kind: string }>;
			assert.equal(rows.length, 1);
			assert.equal(rows[0].kind, '"bb.native-child-binding"');
		} finally {
			db.close();
		}

		const manager = new DurableBindingManager();
		const actual = manager.readOfflineBindings(dir);
		assert.equal(actual.length, 1);
		assert.equal(actual[0].bbThreadId, "synthetic-thread");
		assert.equal(actual[0].conversationId, String(ROOT_CONVERSATION_ID));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
