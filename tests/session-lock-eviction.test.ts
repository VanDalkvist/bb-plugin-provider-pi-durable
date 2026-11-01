import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import lockfile from "proper-lockfile";
import {
	selectSession,
	isProcessAlive,
	type SessionOwnerInfo,
} from "../src/runner/session-storage.ts";

describe("Session Lock Eviction and Ownership Tracking (Cycle 71, D-20)", () => {
	it("isProcessAlive correctly checks process liveness", () => {
		assert.equal(isProcessAlive(process.pid), true);
		assert.equal(isProcessAlive(0), false);
		assert.equal(isProcessAlive(-1), false);
		assert.equal(isProcessAlive(9999999), false);
	});

	it("writes session.owner.json upon lock acquisition and removes it on release", async () => {
		const temp = mkdtempSync(join(tmpdir(), "pi-owner-test-"));
		try {
			const targetDir = join(temp, "test-session");
			const session = await selectSession(temp, false, targetDir);

			const ownerFile = join(session.directory, "session.owner.json");
			assert.ok(existsSync(ownerFile), "session.owner.json must exist while session is held");

			const ownerData: SessionOwnerInfo = JSON.parse(readFileSync(ownerFile, "utf8"));
			assert.equal(ownerData.pid, process.pid);
			assert.equal(ownerData.id, session.id);
			assert.ok(ownerData.startedAt > 0);

			await session.release();
			assert.equal(existsSync(ownerFile), false, "session.owner.json must be removed on release");
			assert.equal(await lockfile.check(session.directory, { realpath: false }), false, "lock must be released");
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("forcibly evicts stale lock and session.owner.json left by dead PID", async () => {
		const temp = mkdtempSync(join(tmpdir(), "pi-dead-lock-test-"));
		try {
			const targetDir = join(temp, "dead-session");
			mkdirSync(targetDir, { recursive: true });

			// Simulate stale lock and owner file left by non-existent dead PID
			const deadPid = 9999998;
			assert.equal(isProcessAlive(deadPid), false);

			mkdirSync(`${targetDir}.lock`, { recursive: true });
			writeFileSync(
				join(targetDir, "session.owner.json"),
				JSON.stringify({ pid: deadPid, id: "dead-session", cwd: temp, startedAt: Date.now() - 10000 }),
				"utf8",
			);

			// Calling selectSession should evict the stale lock and dead owner file
			const session = await selectSession(temp, false, targetDir);
			try {
				const ownerFile = join(session.directory, "session.owner.json");
				assert.ok(existsSync(ownerFile));
				const ownerData: SessionOwnerInfo = JSON.parse(readFileSync(ownerFile, "utf8"));
				assert.equal(ownerData.pid, process.pid, "new owner pid must be the active process pid");
			} finally {
				await session.release();
			}
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("fails closed when another live runner process holds the session lock", async () => {
		const temp = mkdtempSync(join(tmpdir(), "pi-orphan-takeover-test-"));
		const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"]);
		assert.ok(orphan.pid);
		assert.equal(isProcessAlive(orphan.pid), true);

		try {
			const targetDir = join(temp, "orphan-session");
			mkdirSync(targetDir, { recursive: true });

			// Simulate another live runner process holding the lock and owner file
			mkdirSync(`${targetDir}.lock`, { recursive: true });
			writeFileSync(
				join(targetDir, "session.owner.json"),
				JSON.stringify({ pid: orphan.pid, id: "orphan-session", cwd: temp, startedAt: Date.now() }),
				"utf8",
			);

			// selectSession must fail closed and NEVER send SIGTERM to live process
			await assert.rejects(
				async () => selectSession(temp, false, targetDir),
				(err: Error) => {
					assert.ok(err.message.includes(`PID: ${orphan.pid}`));
					assert.ok(err.message.includes("Session is already open in another live process"));
					return true;
				},
			);
			assert.equal(isProcessAlive(orphan.pid), true, "Live runner process must NOT be killed with SIGTERM");
		} finally {
			orphan.kill("SIGKILL");
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("fails with actionable error containing holding PID if process is alive", async () => {
		const temp = mkdtempSync(join(tmpdir(), "pi-stubborn-test-"));
		const stubborn = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"]);
		assert.ok(stubborn.pid);

		try {
			const targetDir = join(temp, "stubborn-session");
			mkdirSync(targetDir, { recursive: true });

			mkdirSync(`${targetDir}.lock`, { recursive: true });
			writeFileSync(
				join(targetDir, "session.owner.json"),
				JSON.stringify({ pid: stubborn.pid, id: "stubborn-session", cwd: temp, startedAt: Date.now() }),
				"utf8",
			);

			await assert.rejects(
				async () => selectSession(temp, false, targetDir),
				(err: Error) => {
					assert.ok(err.message.includes(`PID: ${stubborn.pid}`));
					assert.ok(err.message.includes("Session is already open in another live process"));
					return true;
				},
			);
		} finally {
			stubborn.kill("SIGKILL");
			rmSync(temp, { recursive: true, force: true });
		}
	});
});
