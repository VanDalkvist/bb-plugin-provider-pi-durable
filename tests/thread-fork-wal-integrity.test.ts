import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { forkSessionDatabase } from "../src/host/thread-fork.ts";

test("Thread Fork WAL Integrity: safe SQLite fork never copies .sqlite-shm and maintains WAL data integrity", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-thread-fork-wal-test-"));
	const env = { ...process.env, BB_PI_BRIDGE_SESSION_DIR: tempDir };

	try {
		const parentDir = join(tempDir, "parent_wal_session");
		mkdirSync(parentDir, { recursive: true });

		// 1. Create parent database in WAL mode with active transactions
		const parentDbPath = join(parentDir, "session.sqlite");
		const db = new DatabaseSync(parentDbPath);
		db.exec("PRAGMA journal_mode = WAL;");
		db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER, record TEXT);");
		db.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, status TEXT);");

		db.exec("INSERT INTO entries VALUES (1, 1, '{\"text\":\"first\"}');");
		db.exec("INSERT INTO tasks VALUES (101, 'completed');");
		db.exec("INSERT INTO entries VALUES (2, 1, '{\"text\":\"second\"}');");
		db.exec("INSERT INTO tasks VALUES (102, 'completed');");
		db.exec("INSERT INTO entries VALUES (3, 1, '{\"text\":\"third\"}');");
		// Explicitly simulate presence of WAL and SHM files in active session
		const parentShm = join(parentDir, "session.sqlite-shm");
		if (!existsSync(parentShm)) {
			writeFileSync(parentShm, "active-shm-mapping");
		}
		assert.ok(existsSync(parentShm), "Parent shm must exist before fork");

		// 2. Perform fork to child session with checkpointId = 2
		const childId = "child_wal_session";
		forkSessionDatabase({
			sourceProviderThreadId: parentDir,
			targetProviderThreadId: childId,
			checkpointId: 2,
			env,
		});
		db.close();

		const childDir = join(tempDir, childId);
		const childDbPath = join(childDir, "session.sqlite");
		const childShmPath = join(childDir, "session.sqlite-shm");

		// 3. Verify .sqlite-shm is NEVER copied into the child directory (AP-013 violation)
		assert.equal(existsSync(childShmPath), false, ".sqlite-shm must never be copied to child session");

		// 4. Verify child database is valid and clean
		assert.ok(existsSync(childDbPath), "Child database must exist");
		const childDb = new DatabaseSync(childDbPath, { readOnly: true });
		try {
			const entries = childDb.prepare("SELECT id FROM entries ORDER BY id ASC").all() as Array<{ id: number }>;
			assert.deepEqual(entries.map((e) => e.id), [1, 2], "Entries > checkpoint must be pruned");
		} finally {
			childDb.close();
		}
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});
