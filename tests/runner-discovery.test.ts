import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRunnerPath } from "../src/host/paths.ts";

describe("Runner Path Discovery & Portability (Issue #2)", () => {
	it("honors BB_PI_DURABLE_BRIDGE_COMMAND explicit override", () => {
		const temp = mkdtempSync(join(tmpdir(), "runner-test-env-"));
		const fakeRunner = join(temp, "custom-runner.js");
		writeFileSync(fakeRunner, "// custom runner");

		const saved = process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		try {
			process.env.BB_PI_DURABLE_BRIDGE_COMMAND = fakeRunner;
			const resolved = resolveRunnerPath();
			assert.equal(resolved, fakeRunner);
		} finally {
			if (saved === undefined) delete process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
			else process.env.BB_PI_DURABLE_BRIDGE_COMMAND = saved;
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("honors PI_DURABLE_RUNNER_PATH explicit override", () => {
		const temp = mkdtempSync(join(tmpdir(), "runner-test-env2-"));
		const fakeRunner = join(temp, "custom-runner2.js");
		writeFileSync(fakeRunner, "// custom runner 2");

		const savedBridge = process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		const savedRunner = process.env.PI_DURABLE_RUNNER_PATH;
		delete process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		try {
			process.env.PI_DURABLE_RUNNER_PATH = fakeRunner;
			const resolved = resolveRunnerPath();
			assert.equal(resolved, fakeRunner);
		} finally {
			if (savedBridge !== undefined) process.env.BB_PI_DURABLE_BRIDGE_COMMAND = savedBridge;
			if (savedRunner === undefined) delete process.env.PI_DURABLE_RUNNER_PATH;
			else process.env.PI_DURABLE_RUNNER_PATH = savedRunner;
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("resolves runner when host is executed from isolated host-cache directory", () => {
		const root = mkdtempSync(join(tmpdir(), "bb-host-cache-test-"));
		const packageRoot = join(root, "plugin");
		const cacheRoot = join(root, "host-cache");
		mkdirSync(join(packageRoot, "dist", "runner"), { recursive: true });
		mkdirSync(cacheRoot, { recursive: true });

		const runner = join(packageRoot, "dist", "runner", "index.js");
		writeFileSync(runner, "// test runner in package");

		const savedBridge = process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		const savedRunner = process.env.PI_DURABLE_RUNNER_PATH;
		delete process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		delete process.env.PI_DURABLE_RUNNER_PATH;

		try {
			const resolved = resolveRunnerPath({ fromDir: cacheRoot });
			assert.equal(resolved, runner);
		} finally {
			if (savedBridge !== undefined) process.env.BB_PI_DURABLE_BRIDGE_COMMAND = savedBridge;
			if (savedRunner !== undefined) process.env.PI_DURABLE_RUNNER_PATH = savedRunner;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("resolves runner in paths containing spaces", () => {
		const root = mkdtempSync(join(tmpdir(), "bb test with spaces-"));
		const packageRoot = join(root, "plugin path with spaces");
		const cacheRoot = join(root, "host cache with spaces");
		mkdirSync(join(packageRoot, "dist", "runner"), { recursive: true });
		mkdirSync(cacheRoot, { recursive: true });

		const runner = join(packageRoot, "dist", "runner", "index.js");
		writeFileSync(runner, "// test runner in space package");

		const savedBridge = process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		const savedRunner = process.env.PI_DURABLE_RUNNER_PATH;
		delete process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		delete process.env.PI_DURABLE_RUNNER_PATH;

		try {
			const resolved = resolveRunnerPath({ fromDir: cacheRoot });
			assert.equal(resolved, runner);
		} finally {
			if (savedBridge !== undefined) process.env.BB_PI_DURABLE_BRIDGE_COMMAND = savedBridge;
			if (savedRunner !== undefined) process.env.PI_DURABLE_RUNNER_PATH = savedRunner;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("throws actionable error on genuinely missing runner without maintainer path", () => {
		const root = mkdtempSync(join(tmpdir(), "bb-empty-test-"));
		const cacheRoot = join(root, "host-cache");
		mkdirSync(cacheRoot, { recursive: true });

		const savedBridge = process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		const savedRunner = process.env.PI_DURABLE_RUNNER_PATH;
		delete process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		delete process.env.PI_DURABLE_RUNNER_PATH;

		try {
			assert.throws(
				() => resolveRunnerPath({ fromDir: cacheRoot }),
				(err: Error) => {
					assert.ok(err.message.includes("internal runner bundle not found"));
					assert.ok(!err.message.includes("/Users/vanya/Projects/bb-plugin-provider-pi-durable"), "must not include author-specific repo path");
					return true;
				},
			);
		} finally {
			if (savedBridge !== undefined) process.env.BB_PI_DURABLE_BRIDGE_COMMAND = savedBridge;
			if (savedRunner !== undefined) process.env.PI_DURABLE_RUNNER_PATH = savedRunner;
			rmSync(root, { recursive: true, force: true });
		}
	});
});
