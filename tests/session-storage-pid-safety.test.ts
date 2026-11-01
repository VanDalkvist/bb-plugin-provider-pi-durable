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
