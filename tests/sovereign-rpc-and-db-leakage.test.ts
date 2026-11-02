import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const threadForkPath = fileURLToPath(new URL("../src/host/thread-fork.ts", import.meta.url));
const runnerProcessPath = fileURLToPath(new URL("../src/host/runner-process.ts", import.meta.url));

test("Defect D-106-01: thread-fork.ts must NOT import node:sqlite or DatabaseSync", () => {
	const content = readFileSync(threadForkPath, "utf8");
	assert.equal(
		content.includes("node:sqlite"),
		false,
		"src/host/thread-fork.ts must not import node:sqlite (AP-002: Zero DB Leakage)",
	);
	assert.equal(
		content.includes("DatabaseSync"),
		false,
		"src/host/thread-fork.ts must not use DatabaseSync directly",
	);
});

test("Defect D-106-02 & D-106-04: RunnerProcess must use strictly 3 stdio pipes ['pipe', 'pipe', 'pipe'] without FD 3/4", () => {
	const content = readFileSync(runnerProcessPath, "utf8");
	assert.equal(
		content.includes('["pipe", "pipe", "pipe", "pipe", "pipe"]'),
		false,
		"RunnerProcess must not use 5 stdio pipes (FD 3/4 leak)",
	);
	assert.ok(
		content.includes('["pipe", "pipe", "pipe"]'),
		"RunnerProcess must spawn with strictly standard POSIX stdio: ['pipe', 'pipe', 'pipe']",
	);
});
