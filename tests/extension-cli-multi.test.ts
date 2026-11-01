import test from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs } from "../src/runner/cli-args.ts";

test("parseCliArgs: supports multiple --extension flags and --no-global-extensions", () => {
	const argv = [
		"--extension", "/path/to/ext1.ts",
		"--extension", "/path/to/ext2.mjs",
		"--no-global-extensions",
		"--session-dir", "/tmp/sessions",
	];

	const parsed = parseCliArgs(argv);
	assert.deepEqual(parsed.extensions, ["/path/to/ext1.ts", "/path/to/ext2.mjs"]);
	assert.equal(parsed.noGlobalExtensions, true);
});
