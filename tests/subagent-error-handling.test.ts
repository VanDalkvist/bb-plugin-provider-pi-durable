import test from "node:test";
import assert from "node:assert/strict";
import { createSubagentExtension } from "../src/runner/subagent.ts";

test("Subagent module is exported and valid", () => {
	const subagentExt = createSubagentExtension(() => ({
		version: 1,
		revision: 0,
		policy: { mode: "inherit" },
	}));
	assert.equal(subagentExt.name, "subagent");
	const tool = subagentExt.tools?.[0];
	assert.ok(tool);
	assert.equal(tool.name, "subagent");
});
