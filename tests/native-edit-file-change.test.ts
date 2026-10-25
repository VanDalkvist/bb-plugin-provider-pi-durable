import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePatch, applyPatch } from "diff";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { createEditTool } from "@earendil-works/pi-coding-agent";
import { translateToolStart, translateToolEnd } from "../src/host/tool-delta-translator.ts";

interface FileChangeItem {
	type: string;
	changes: Array<{ path: string; kind: string; diff?: string }>;
}

function sampleContent(count = 60): string {
	return `${Array.from({ length: count }, (_, i) => `const line_${i + 1} = ${i + 1};`).join("\n")}\n`;
}

test("native multi-hunk edit translates to single fileChange item with canonical unified git diff", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-edit-multi-"));
	const testFile = path.join(tmpDir, "sample.ts");
	const before = sampleContent(60);
	fs.writeFileSync(testFile, before, "utf8");

	try {
		const tool = createEditTool(tmpDir);
		const edits = [
			{ oldText: "const line_5 = 5;", newText: "const line_5 = 500;" },
			{ oldText: "const line_30 = 30;", newText: "const line_30 = 3000;" },
			{ oldText: "const line_55 = 55;", newText: "const line_55 = 5500;" },
		];
		const res = await tool.execute("call_multi_1", { path: "sample.ts", edits });
		const after = fs.readFileSync(testFile, "utf8");

		const start = translateToolStart(
			{ type: "tool_execution_start", toolCallId: "call_multi_1", toolName: "edit", args: { path: "sample.ts", edits } },
			tmpDir,
		);
		assert.equal(start.delta.kind, "item.open");
		const startItem = start.shape as unknown as FileChangeItem;
		assert.equal(startItem.type, "fileChange");
		assert.equal(startItem.changes.length, 1);
		assert.equal(startItem.changes[0].path, "sample.ts");
		assert.equal(startItem.changes[0].kind, "update");

		const end = translateToolEnd(
			{
				type: "tool_execution_end",
				toolCallId: "call_multi_1",
				toolName: "edit",
				result: res.content[0]?.type === "text" ? res.content[0].text : "",
				details: res.details,
				isError: false,
			},
			start.shape,
			tmpDir,
		);
		assert.equal(end.kind, "item.close");
		const endItem = end.item as unknown as FileChangeItem;
		assert.equal(endItem.changes.length, 1);

		const diff = endItem.changes[0].diff;
		assert.ok(diff && diff.startsWith("diff --git a/sample.ts b/sample.ts\n"));
		const parsed = parsePatch(diff);
		assert.equal(parsed.length, 1);
		assert.equal(parsed[0].hunks.length, 3);

		const patched = applyPatch(before, diff);
		assert.equal(patched, after, "Applying translated patch must yield exact after-content byte-for-byte");
		assert.equal(threadDeltaSchema.safeParse(end).success, true);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("native single-hunk edit translates cleanly and applies byte-for-byte", async () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-edit-single-"));
	const testFile = path.join(tmpDir, "single.ts");
	const before = "line 1\nline 2: target\nline 3\n";
	fs.writeFileSync(testFile, before, "utf8");

	try {
		const tool = createEditTool(tmpDir);
		const edits = [{ oldText: "line 2: target", newText: "line 2: MODIFIED" }];
		const res = await tool.execute("call_single_1", { path: "single.ts", edits });
		const after = fs.readFileSync(testFile, "utf8");

		const start = translateToolStart(
			{ type: "tool_execution_start", toolCallId: "call_single_1", toolName: "edit", args: { path: "single.ts", edits } },
			tmpDir,
		);
		const end = translateToolEnd(
			{
				type: "tool_execution_end",
				toolCallId: "call_single_1",
				toolName: "edit",
				result: res.content[0]?.type === "text" ? res.content[0].text : "",
				details: res.details,
				isError: false,
			},
			start.shape,
			tmpDir,
		);

		const endItem = end.item as unknown as FileChangeItem;
		assert.equal(endItem.changes.length, 1);
		const diff = endItem.changes[0].diff;
		assert.ok(diff);

		const parsed = parsePatch(diff);
		assert.equal(parsed[0].hunks.length, 1);
		assert.equal(applyPatch(before, diff), after);
		assert.equal(threadDeltaSchema.safeParse(end).success, true);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("distinct edit calls on different files preserve separate call identity and do not merge", () => {
	const start1 = translateToolStart(
		{ type: "tool_execution_start", toolCallId: "call_a", toolName: "edit", args: { path: "fileA.ts" } },
		"/workspace",
	);
	const start2 = translateToolStart(
		{ type: "tool_execution_start", toolCallId: "call_b", toolName: "edit", args: { path: "fileB.ts" } },
		"/workspace",
	);

	assert.equal(start1.delta.key.providerItemId, "call_a");
	assert.equal(start2.delta.key.providerItemId, "call_b");
	const item1 = start1.shape as unknown as FileChangeItem;
	const item2 = start2.shape as unknown as FileChangeItem;
	assert.equal(item1.changes[0].path, "fileA.ts");
	assert.equal(item2.changes[0].path, "fileB.ts");
});

test("custom producer with valid diff-only (no patch field) remains supported", () => {
	const customDiff = ["--- a/custom.ts", "+++ b/custom.ts", "@@ -1,1 +1,1 @@", "-alpha", "+beta", ""].join("\n");
	const start = translateToolStart(
		{ type: "tool_execution_start", toolCallId: "call_c", toolName: "edit", args: { path: "custom.ts" } },
		"/workspace",
	);
	const end = translateToolEnd(
		{
			type: "tool_execution_end",
			toolCallId: "call_c",
			toolName: "edit",
			result: "done",
			details: { diff: customDiff },
			isError: false,
		},
		start.shape,
		"/workspace",
	);

	const endItem = end.item as unknown as FileChangeItem;
	assert.ok(endItem.changes[0].diff?.startsWith("diff --git a/custom.ts b/custom.ts\n"));
	assert.equal(parsePatch(endItem.changes[0].diff)[0].hunks.length, 1);
});
