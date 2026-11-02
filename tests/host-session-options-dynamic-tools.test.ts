import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildSessionOptions } from "../src/host/session-options.ts";

test("buildSessionOptions serializes dynamic tools and filters disallowed tools", () => {
	const params = {
		cwd: "/test/cwd",
		dynamicTools: [
			{ name: "check_ui", description: "check ui", inputSchema: {} },
			{ name: "disallowed_tool", description: "blocked", inputSchema: {} },
		],
		disallowedTools: ["disallowed_tool"],
	};

	const opts = buildSessionOptions("thr_1", "pi_thread_1", "pi_thread_1", params as any, []);
	assert.ok(opts.toolsFilePath, "toolsFilePath must be populated");
	assert.ok(fs.existsSync(opts.toolsFilePath), "tools file must be written to disk");

	const content = JSON.parse(fs.readFileSync(opts.toolsFilePath, "utf8"));
	assert.equal(content.length, 1);
	assert.equal(content[0].name, "check_ui");

	// Clean up
	fs.unlinkSync(opts.toolsFilePath);
});
