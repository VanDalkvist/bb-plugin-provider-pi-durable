import test from "node:test";
import assert from "node:assert/strict";
import { isVerifiedRunnerProcess } from "../src/runner/session-storage.ts";

test("isVerifiedRunnerProcess: returns true for current node process", () => {
	const currentOwner = {
		pid: process.pid,
		id: "test-session",
		cwd: process.cwd(),
		startedAt: Date.now(),
	};
	assert.equal(isVerifiedRunnerProcess(currentOwner), true, "Current node process must be recognized as valid runner");
});

test("isVerifiedRunnerProcess: returns false for non-existent or invalid PID", () => {
	const invalidOwner = {
		pid: 9999999, // impossible PID
		id: "test-session",
		cwd: process.cwd(),
		startedAt: Date.now(),
	};
	assert.equal(isVerifiedRunnerProcess(invalidOwner), false, "Non-existent PID must return false");
});

test("isVerifiedRunnerProcess: returns false for PID 0 or negative", () => {
	assert.equal(isVerifiedRunnerProcess({ pid: 0, id: "", cwd: "", startedAt: 0 }), false);
	assert.equal(isVerifiedRunnerProcess({ pid: -1, id: "", cwd: "", startedAt: 0 }), false);
});

test("acquireSessionLock fails closed and does not kill live runner process", { timeout: 5000 }, async () => {
	const { selectSession, isProcessAlive } = await import("../src/runner/session-storage.ts");
	const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { spawn } = await import("node:child_process");

	const temp = mkdtempSync(join(tmpdir(), "pi-live-lock-test-"));
	const dummyRunner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"]);
	assert.ok(dummyRunner.pid);

	try {
		const targetDir = join(temp, "active-session");
		mkdirSync(targetDir, { recursive: true });
		mkdirSync(`${targetDir}.lock`, { recursive: true });
		writeFileSync(
			join(targetDir, "session.owner.json"),
			JSON.stringify({ pid: dummyRunner.pid, id: "active-session", cwd: temp, startedAt: Date.now() }),
			"utf8",
		);

		await assert.rejects(
			async () => {
				await selectSession(temp, false, targetDir);
			},
			(err: any) => {
				return err.message.includes(`Session is already open in another live process (PID: ${dummyRunner.pid})`);
			},
			"Should fail closed when another live runner holds lock",
		);

		// The dummy runner MUST still be alive (not murdered by SIGTERM!)
		assert.equal(isProcessAlive(dummyRunner.pid), true, "Live runner process must NOT be killed with SIGTERM");
	} finally {
		dummyRunner.kill("SIGKILL");
		rmSync(temp, { recursive: true, force: true });
	}
});
