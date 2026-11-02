import test from "node:test";
import assert from "node:assert/strict";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import {
	buildToolItemShape,
	translateToolStart,
	translateToolEnd,
	normalizeFilePath,
	synthesizeAddDiff,
	normalizeGitPatch,
} from "../src/host/tool-delta-translator.ts";

interface FileChangeItem {
	type: string;
	changes: Array<{ path: string; kind: string; diff?: string; newText?: string }>;
}

test("buildToolItemShape maps 'write' tool to BB compliant fileChange with kind: 'add'", () => {
	const shape = buildToolItemShape(
		"write",
		{ path: "/Users/vanya/test.ts", content: "console.log('hello');" },
		"/Users/vanya",
	);

	assert.equal(shape.type, "fileChange");
	const item = shape as unknown as FileChangeItem;
	assert.ok(Array.isArray(item.changes));
	assert.equal(item.changes.length, 1);
	assert.equal(item.changes[0].path, "/Users/vanya/test.ts");
	assert.equal(item.changes[0].kind, "add"); // MUST be "add", not "create"
	assert.equal(item.changes[0].newText, "console.log('hello');");
});

test("buildToolItemShape maps 'edit' tool to BB compliant fileChange with kind: 'update' and single file entry", () => {
	const shape = buildToolItemShape(
		"edit",
		{
			path: "/Users/vanya/test.ts",
			edits: [
				{ oldText: "foo", newText: "bar" },
				{ oldText: "baz", newText: "qux" },
			],
		},
		"/Users/vanya",
	);

	assert.equal(shape.type, "fileChange");
	const item = shape as unknown as FileChangeItem;
	assert.ok(Array.isArray(item.changes));
	assert.equal(item.changes.length, 1);
	assert.equal(item.changes[0].path, "/Users/vanya/test.ts");
	assert.equal(item.changes[0].kind, "update"); // MUST be "update", not "modify"
});

test("translateToolStart and translateToolEnd retain valid fileChange item", () => {
	const start = translateToolStart(
		{
			type: "tool_execution_start",
			toolCallId: "call_edit_1",
			toolName: "edit",
			args: {
				path: "/Users/vanya/file.ts",
				edits: [{ oldText: "old", newText: "new" }],
			},
		},
		"/Users/vanya",
	);

	assert.equal(start.delta.kind, "item.open");
	assert.equal(start.shape.type, "fileChange");
	const startItem = start.shape as unknown as FileChangeItem;
	assert.equal(startItem.changes[0].kind, "update");

	const end = translateToolEnd(
		{
			type: "tool_execution_end",
			toolCallId: "call_edit_1",
			toolName: "edit",
			result: "Successfully replaced 1 block(s)",
			isError: false,
		},
		start.shape,
		"/Users/vanya",
	);

	assert.equal(end.kind, "item.close");
	assert.equal(end.status, "completed");
	const endItem = end.item as unknown as FileChangeItem;
	assert.equal(endItem.type, "fileChange");
	assert.equal(endItem.changes[0].kind, "update");
});

test("D-21: normalizeFilePath strips spurious b/ and a/ prefixes and relative dots", () => {
	assert.equal(normalizeFilePath("b/tests/master-parity-conformance.test.ts"), "tests/master-parity-conformance.test.ts");
	assert.equal(normalizeFilePath("a/src/host/diff-utils.ts"), "src/host/diff-utils.ts");
	assert.equal(normalizeFilePath("./b/tests/demo.test.ts"), "tests/demo.test.ts");
	assert.equal(normalizeFilePath("./src/app.ts"), "src/app.ts");
	assert.equal(normalizeFilePath("tests/unit.test.ts"), "tests/unit.test.ts");
	assert.equal(normalizeFilePath(""), "");
	assert.equal(normalizeFilePath(undefined), "");
});

test("D-21: synthesizeAddDiff generates canonical git unified diff with exact line counts", () => {
	const content = "line 1\nline 2\nline 3\n";
	const diff = synthesizeAddDiff("b/tests/example.ts", content);
	const expected = [
		"diff --git a/tests/example.ts b/tests/example.ts",
		"--- /dev/null",
		"+++ b/tests/example.ts",
		"@@ -0,0 +1,3 @@",
		"+line 1",
		"+line 2",
		"+line 3",
		"",
	].join("\n");
	assert.equal(diff, expected);

	// Empty content case: line count 0
	const emptyDiff = synthesizeAddDiff("b/empty.txt", "");
	const expectedEmpty = [
		"diff --git a/empty.txt b/empty.txt",
		"--- /dev/null",
		"+++ b/empty.txt",
		"@@ -0,0 +0,0 @@",
		"",
	].join("\n");
	assert.equal(emptyDiff, expectedEmpty);
});

test("D-21: translateToolEnd synthesizes canonical unified git diff for write tool and validates schema", () => {
	const start = translateToolStart(
		{
			type: "tool_execution_start",
			toolCallId: "call_write_1",
			toolName: "write",
			args: {
				path: "b/tests/master-parity-conformance.test.ts",
				content: "import test from 'node:test';\nassert.ok(true);\n",
			},
		},
		"/workspace",
	);

	const end = translateToolEnd(
		{
			type: "tool_execution_end",
			toolCallId: "call_write_1",
			toolName: "write",
			result: "File written successfully",
			isError: false,
		},
		start.shape,
		"/workspace",
	);

	assert.equal(end.kind, "item.close");
	assert.equal(end.status, "completed");

	const item = end.item as unknown as FileChangeItem;
	assert.equal(item.type, "fileChange");
	assert.equal(item.changes.length, 1);
	assert.equal(item.changes[0].path, "tests/master-parity-conformance.test.ts");
	assert.equal(item.changes[0].kind, "add");

	const expectedDiff = [
		"diff --git a/tests/master-parity-conformance.test.ts b/tests/master-parity-conformance.test.ts",
		"--- /dev/null",
		"+++ b/tests/master-parity-conformance.test.ts",
		"@@ -0,0 +1,2 @@",
		"+import test from 'node:test';",
		"+assert.ok(true);",
		"",
	].join("\n");

	assert.equal(item.changes[0].diff, expectedDiff);

	const validation = threadDeltaSchema.safeParse(end);
	assert.equal(validation.success, true);
});

test("D-21: normalizeGitPatch standardizes patch headers for edit tool with clean paths", () => {
	const patchWithoutGit = ["--- a/tests/foo.ts", "+++ b/tests/foo.ts", "@@ -1,2 +1,2 @@", "-old", "+new"].join("\n");
	const normalized = normalizeGitPatch(patchWithoutGit, "b/tests/foo.ts", "update");
	const expected = [
		"diff --git a/tests/foo.ts b/tests/foo.ts",
		"--- a/tests/foo.ts",
		"+++ b/tests/foo.ts",
		"@@ -1,2 +1,2 @@",
		"-old",
		"+new",
		"",
	].join("\n");
	assert.equal(normalized, expected);
});

test("bash command tool presentation: preserves command text across start and end", () => {
	const start = translateToolStart(
		{
			type: "tool_execution_start",
			toolCallId: "call_bash_42",
			toolName: "bash",
			args: { command: "git status --porcelain" },
		},
		"/Users/vanya/work",
	);

	assert.equal(start.delta.kind, "item.open");
	const startItem = start.delta.item as { type: string; command: string };
	assert.equal(startItem.type, "command");
	assert.equal(startItem.command, "git status --porcelain");

	const end = translateToolEnd(
		{
			type: "tool_execution_end",
			toolCallId: "call_bash_42",
			toolName: "bash",
			result: "M file.ts",
			isError: false,
		},
		start.shape,
		"/Users/vanya/work",
	);

	assert.equal(end.kind, "item.close");
	const endItem = end.item as { type: string; command: string };
	assert.equal(endItem.type, "command");
	assert.equal(endItem.command, "git status --porcelain");
});

test("bash command tool presentation: recovers command from event.args when cachedShape is missing", () => {
	const end = translateToolEnd(
		{
			type: "tool_execution_end",
			toolCallId: "call_bash_unpaired",
			toolName: "bash",
			result: "error output",
			isError: true,
			args: { command: "npm test" },
		} as any,
		undefined, // simulated missing cachedShape
		"/Users/vanya/work",
	);

	assert.equal(end.kind, "item.close");
	assert.equal(end.status, "failed");
	const endItem = end.item as { type: string; command: string };
	assert.equal(endItem.type, "command");
	assert.equal(endItem.command, "npm test");
});
