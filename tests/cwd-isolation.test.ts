import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PiThreadSession } from "../src/host/session.ts";
import { parseCliArgs } from "../src/runner/cli-args.ts";

describe("CWD Isolation and CLI Argument Parsing (Issue #1)", () => {
	it("PiThreadSession does not pass unsupported --session-dir to runner", () => {
		const projectDir = process.cwd();
		const session = new PiThreadSession(
			{
				cwd: projectDir,
				sessionFilePath: "/tmp/thread-1.jsonl",
				sessionDir: "/tmp",
				extensionPath: "/tmp/ext.mjs",
				threadId: "thr_test1",
			},
			() => {},
		);

		try {
			const args = session.runner.options.args;
			assert.equal(args.includes("--session-dir"), false, "args should not include --session-dir");
			assert.equal(session.runner.options.cwd, projectDir);

			const parsed = parseCliArgs(args);
			const effectiveCwd = parsed.cwd ?? session.runner.options.cwd;
			assert.equal(effectiveCwd, projectDir, "effective cwd must remain the project directory");
		} finally {
			session.runner.kill();
		}
	});

	it("parseCliArgs parses --session-dir without overriding cwd", () => {
		const parsed = parseCliArgs(["--session", "/sessions/s1", "--session-dir", "/sessions/dir", "--mode", "rpc"]);
		assert.equal(parsed.sessionDir, "/sessions/dir");
		assert.equal(parsed.cwd, undefined, "cwd must not be populated by --session-dir value");
	});

	it("parseCliArgs does not let unknown options with values become positional cwd", () => {
		const parsed = parseCliArgs(["--unknown-flag", "some-value", "--another-flag", "123"]);
		assert.equal(parsed.cwd, undefined, "unknown flag value must not become positional cwd");
	});

	it("parseCliArgs honors deliberate positional cwd", () => {
		const parsed = parseCliArgs(["--mode", "rpc", "--session", "/sessions/s1", "/workspace/target-project"]);
		assert.equal(parsed.cwd, "/workspace/target-project");
	});

	it("parseCliArgs supports paths with spaces", () => {
		const parsed = parseCliArgs([
			"--session",
			"/sessions with spaces/s1",
			"--session-dir",
			"/sessions with spaces",
			"/workspace with spaces/my project",
		]);
		assert.equal(parsed.sessionDir, "/sessions with spaces");
		assert.equal(parsed.session, "/sessions with spaces/s1");
		assert.equal(parsed.cwd, "/workspace with spaces/my project");
	});
});
