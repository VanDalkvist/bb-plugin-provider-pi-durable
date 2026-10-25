import test from "node:test";
import assert from "node:assert/strict";
import { runCompactionSideEffect } from "../src/runner/compaction-hooks.ts";
import { readFileSync } from "node:fs";

test("rejected compact context is diagnosed distinctly, not silently treated as empty context", async () => {
	const cause = new Error("SECRET_CONTEXT_PROMPT");
	const notices: Array<{ level: string; message: string }> = [];
	const result = await runCompactionSideEffect("compact_context", async () => { throw cause; }, (level, message) => notices.push({ level, message }));
	assert.equal(result.status, "failed");
	if (result.status !== "failed") assert.fail("failure converted to successful empty context");
	assert.equal(result.error.cause, cause);
	assert.equal(result.error.code, "CONTEXT_RETRIEVAL_FAILED");
	assert.equal(notices[0].level, "warning");
	assert.ok(!JSON.stringify(notices).includes("SECRET_CONTEXT_PROMPT"));
});

test("rejected post-compact hook is best effort with safe causal diagnostic, not a new native failure", async () => {
	const cause = new TypeError("SECRET_EXTENSION_BODY");
	const notices: string[] = [];
	const result = await runCompactionSideEffect("session_compact", async () => { throw cause; }, (_level, message) => notices.push(message));
	assert.equal(result.status, "failed");
	if (result.status !== "failed") assert.fail("hook rejection hidden");
	assert.equal(result.error.cause, cause);
	assert.equal(result.error.code, "COMPACTION_HOOK_FAILED");
	assert.ok(notices[0].includes("session_compact"));
	assert.ok(!notices[0].includes("SECRET_EXTENSION_BODY"));
});

test("successful hook preserves value and the controller has no silent compact catches", async () => {
	const result = await runCompactionSideEffect("session_before_compact", async () => "ok", () => assert.fail("unexpected warning"));
	assert.deepEqual(result, { status: "succeeded", value: "ok" });
	const source = readFileSync(new URL("../src/runner/runtime-controller.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /\.catch\(\(\) => (?:\{\}|undefined)\)/);
});
