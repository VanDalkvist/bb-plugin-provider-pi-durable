import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

test("BindingDoc and BindingIndexDoc definitions and identityKey", () => {
	assert.equal(BindingDoc.definition.kind, "bb.native-child-binding");
	assert.equal(BindingDoc.definition.version, 2);
	assert.equal(BindingDoc.definition.scope, "conversation");
	assert.equal(BindingDoc.definition.history, "latest");
	assert.equal(BindingDoc.definition.fork, "initial");
	assert.deepEqual(BindingDoc.definition.initial(), { binding: null });

	assert.equal(BindingIndexDoc.definition.kind, "bb.native-child-binding-index");
	assert.equal(BindingIndexDoc.definition.version, 1);
	assert.equal(BindingIndexDoc.definition.scope, "session");
	assert.deepEqual(BindingIndexDoc.definition.initial(), { byIdentity: {}, byThreadId: {} });

	const key = identityKey({ providerId: "pi-durable", sessionId: "sess_1", bbThreadId: "thr_child" });
	assert.equal(key, JSON.stringify(["pi-durable", "sess_1", "thr_child"]));
});

test("handleBindingCommand: validates register_binding and commits to durable docs", async () => {
	const errors: Array<{ id: string | undefined; cmd: string; msg: string }> = [];
	const successes: Array<{ id: string | undefined; cmd: string; data: unknown }> = [];

	const responder = {
		success: (id: string | undefined, cmd: string, data?: unknown) => successes.push({ id, cmd, data }),
		error: (id: string | undefined, cmd: string, msg: string) => errors.push({ id, cmd, msg }),
	};

	const indexStore: any = { byIdentity: {}, byThreadId: {} };
	const docStore: Record<number, any> = {};

	const mockDurable: any = {
		view: {
			current: () => ({ session: { id: "test-sess-1" } }),
		},
		harness: {
			commit: async (fn: any) => {
				const tx = {
					doc: async (token: any, convId?: number) => {
						if (token === BindingIndexDoc) return indexStore;
						if (token === BindingDoc && convId !== undefined) {
							if (!docStore[convId]) docStore[convId] = { binding: null };
							return docStore[convId];
						}
						throw new Error("Unknown doc token");
					},
				};
				return fn(tx);
			},
			snapshot: async (token: any, convId?: any) => {
				if (token === BindingIndexDoc) return indexStore;
				if (token === BindingDoc && typeof convId === "number") return docStore[convId];
				return undefined;
			},
		},
	};

	// 1. Missing bbThreadId
	const r1 = await handleBindingCommand({ type: "register_binding", id: "1" }, mockDurable, responder);
	assert.equal(r1, true);
	assert.equal(errors.length, 1);
	assert.equal(errors[0].msg, "Missing bbThreadId or conversationId");

	// 2. Invalid conversationId
	const r2 = await handleBindingCommand(
		{ type: "register_binding", id: "2", bbThreadId: "thr_sub_1", conversationId: -5 },
		mockDurable,
		responder,
	);
	assert.equal(r2, true);
	assert.equal(errors.length, 2);

	// 3. Valid register_binding
	const r3 = await handleBindingCommand(
		{
			type: "register_binding",
			id: "3",
			bbThreadId: "thr_sub_1",
			conversationId: 2,
			parentThreadId: "thr_parent_0",
		},
		mockDurable,
		responder,
	);
	assert.equal(r3, true);
	assert.equal(successes.length, 1);
	assert.deepEqual(successes[0], { id: "3", cmd: "register_binding", data: { registered: true } });

	assert.equal(indexStore.byThreadId["thr_sub_1"], 2);
	const expectedIdKey = identityKey({ providerId: "pi-durable", sessionId: "test-sess-1", bbThreadId: "thr_sub_1" });
	assert.equal(indexStore.byIdentity[expectedIdKey], 2);
	assert.equal(docStore[2].binding.bbThreadId, "thr_sub_1");
	assert.equal(docStore[2].binding.parentThreadId, "thr_parent_0");
	assert.equal(docStore[2].binding.conversationId, 2);

	// 4. get_all_bindings
	const r4 = await handleBindingCommand({ type: "get_all_bindings", id: "4" }, mockDurable, responder);
	assert.equal(r4, true);
	assert.equal(successes.length, 2);
	const all = successes[1].data as { bindings: StoredBinding[] };
	assert.equal(all.bindings.length, 1);
	assert.equal(all.bindings[0].bbThreadId, "thr_sub_1");

	// 5. Unknown command returns false
	const r5 = await handleBindingCommand({ type: "prompt", id: "5" }, mockDurable, responder);
	assert.equal(r5, false);
});

test("DurableBindingManager: L1 cache operations and asynchronous RPC sync", async () => {
	const manager = new DurableBindingManager();
	const rpcCalls: any[] = [];
	manager.setRpc(async (cmd) => {
		rpcCalls.push(cmd);
		return { success: true };
	});

	// Register updates L1 cache synchronously
	manager.register("thr_child_42", 5, "thr_root_1");
	assert.equal(manager.getThreadId(5), "thr_child_42");
	assert.equal(manager.getThreadId("5"), "thr_child_42");
	assert.equal(manager.getConversationId("thr_child_42"), "5");

	// RPC call was dispatched
	assert.equal(rpcCalls.length, 1);
	assert.deepEqual(rpcCalls[0], {
		type: "register_binding",
		bbThreadId: "thr_child_42",
		conversationId: 5,
		parentThreadId: "thr_root_1",
	});

	// Unregister updates L1 cache synchronously
	manager.unregister("thr_child_42");
	assert.equal(manager.getThreadId(5), undefined);
	assert.equal(manager.getConversationId("thr_child_42"), undefined);
});

test("DurableBindingManager.hydrateFromRunner: restores thread mappings", async () => {
	const manager = new DurableBindingManager();
	manager.setRpc(async (cmd) => {
		if (cmd.type === "get_all_bindings") {
			return {
				data: {
					bindings: [
						{ bbThreadId: "thr_101", conversationId: 2 },
						{ bbThreadId: "thr_102", conversationId: 3 },
					],
				},
			};
		}
		return {};
	});

	assert.equal(manager.getThreadId(2), undefined);
	await manager.hydrateFromRunner();
	assert.equal(manager.getThreadId(2), "thr_101");
	assert.equal(manager.getThreadId(3), "thr_102");
	assert.equal(manager.getConversationId("thr_101"), "2");
	assert.equal(manager.getConversationId("thr_102"), "3");
});

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
			CREATE TABLE documentRevisions (
				document_id INTEGER,
				seq INTEGER,
				kind TEXT,
				version INTEGER,
				content TEXT
			);
			INSERT INTO documents VALUES (1, 'bb.native-child-binding', 0, '', 'conversation', 7, 1000, NULL, '{}');
			INSERT INTO documentRevisions VALUES (1, 1, 'base', 2, '{"binding":{"bbThreadId":"thr_offline_7","conversationId":7}}');
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
		threadId: "thr_parent_root",
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
