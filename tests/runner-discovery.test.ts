import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir, tmpdir } from "node:os";
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

	it("resolves runner via BB SQLite database plugins table", () => {
		const temp = mkdtempSync(join(tmpdir(), "bb-db-test-"));
		const fakePluginRoot = join(temp, "custom-plugin-workspace");
		mkdirSync(join(fakePluginRoot, "dist", "runner"), { recursive: true });
		const expectedRunner = join(fakePluginRoot, "dist", "runner", "index.js");
		writeFileSync(expectedRunner, "// runner from bb.db root_dir");

		const mockDbFile = join(temp, "test-bb.db");
		const db = new DatabaseSync(mockDbFile);
		db.exec(`
			CREATE TABLE plugins (
				id TEXT PRIMARY KEY,
				root_dir TEXT NOT NULL,
				enabled INTEGER DEFAULT 1,
				updated_at INTEGER DEFAULT 0
			);
			INSERT INTO plugins (id, root_dir, enabled) VALUES ('provider-pi-durable', '${fakePluginRoot}', 1);
		`);
		db.close();

		const savedBridge = process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		const savedRunner = process.env.PI_DURABLE_RUNNER_PATH;
		delete process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		delete process.env.PI_DURABLE_RUNNER_PATH;

		try {
			// Query passing custom bbDbPath
			const resolved = resolveRunnerPath({
				fromDir: join(temp, "isolated-artifact"),
				bbDbPath: mockDbFile,
			});
			assert.equal(resolved, expectedRunner);
		} finally {
			if (savedBridge !== undefined) process.env.BB_PI_DURABLE_BRIDGE_COMMAND = savedBridge;
			if (savedRunner !== undefined) process.env.PI_DURABLE_RUNNER_PATH = savedRunner;
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("resolves runner via BB git cache directory structure", () => {
		const temp = mkdtempSync(join(tmpdir(), "bb-git-cache-test-"));
		const gitCacheDir = join(temp, "cache", "git", "github.com", "org", "bb-plugin-provider-pi-durable", "dist", "runner");
		mkdirSync(gitCacheDir, { recursive: true });
		const expectedRunner = join(gitCacheDir, "index.js");
		writeFileSync(expectedRunner, "// git cache runner");

		const savedBridge = process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		const savedRunner = process.env.PI_DURABLE_RUNNER_PATH;
		delete process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		delete process.env.PI_DURABLE_RUNNER_PATH;

		try {
			const resolved = resolveRunnerPath({
				fromDir: join(temp, "random-dir"),
				cacheDir: join(temp, "cache"),
				bbDbPath: join(temp, "empty.db"),
			});
			assert.equal(resolved, expectedRunner);
		} finally {
			if (savedBridge !== undefined) process.env.BB_PI_DURABLE_BRIDGE_COMMAND = savedBridge;
			if (savedRunner !== undefined) process.env.PI_DURABLE_RUNNER_PATH = savedRunner;
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("resolves runner via BB npm cache directory structure", () => {
		const temp = mkdtempSync(join(tmpdir(), "bb-npm-cache-test-"));
		const npmCacheDir = join(temp, "cache", "npm", "bb-plugin-provider-pi-durable", "1.0.0", "dist", "runner");
		mkdirSync(npmCacheDir, { recursive: true });
		const expectedRunner = join(npmCacheDir, "index.js");
		writeFileSync(expectedRunner, "// npm cache runner");

		const savedBridge = process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		const savedRunner = process.env.PI_DURABLE_RUNNER_PATH;
		delete process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		delete process.env.PI_DURABLE_RUNNER_PATH;

		try {
			const resolved = resolveRunnerPath({
				fromDir: join(temp, "random-dir"),
				cacheDir: join(temp, "cache"),
				bbDbPath: join(temp, "empty.db"),
			});
			assert.equal(resolved, expectedRunner);
		} finally {
			if (savedBridge !== undefined) process.env.BB_PI_DURABLE_BRIDGE_COMMAND = savedBridge;
			if (savedRunner !== undefined) process.env.PI_DURABLE_RUNNER_PATH = savedRunner;
			rmSync(temp, { recursive: true, force: true });
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
			const resolved = resolveRunnerPath({ fromDir: packageRoot });
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
				() => resolveRunnerPath({ fromDir: cacheRoot, bbDbPath: join(root, "missing.db"), cacheDir: join(root, "empty-cache") }),
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

	it("resolves runner on real BB host artifact path when present", () => {
		const realArtifactDir = join(homedir(), ".bb", "plugin-host-artifacts", "provider-pi-durable", "6e4db84ddf8cab895f7af2c6878d61d479ea2f6934bf804cc008797ce29b757c");
		if (!existsSync(realArtifactDir)) return;

		const savedBridge = process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		const savedRunner = process.env.PI_DURABLE_RUNNER_PATH;
		delete process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		delete process.env.PI_DURABLE_RUNNER_PATH;

		try {
			const resolved = resolveRunnerPath({ fromDir: realArtifactDir });
			assert.ok(existsSync(resolved), `resolved runner path must exist on disk: ${resolved}`);
			assert.ok(resolved.endsWith("dist/runner/index.js") || resolved.endsWith("runner/index.js"));
		} finally {
			if (savedBridge !== undefined) process.env.BB_PI_DURABLE_BRIDGE_COMMAND = savedBridge;
			if (savedRunner !== undefined) process.env.PI_DURABLE_RUNNER_PATH = savedRunner;
		}
	});
});
