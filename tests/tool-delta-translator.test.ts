import test from "node:test";
import assert from "node:assert/strict";
import {
	buildToolItemShape,
	translateToolStart,
	translateToolEnd,
} from "../src/host/tool-delta-translator.ts";

test("buildToolItemShape maps 'write' tool to BB compliant fileChange with kind: 'add'", () => {
	const shape = buildToolItemShape(
		"write",
		{ path: "/Users/vanya/test.ts", content: "console.log('hello');" },
		"/Users/vanya",
	);

	assert.equal(shape.type, "fileChange");
	const changes = shape.changes as Array<Record<string, unknown>>;
	assert.ok(Array.isArray(changes));
	assert.equal(changes.length, 1);
	assert.equal(changes[0].path, "/Users/vanya/test.ts");
	assert.equal(changes[0].kind, "add"); // MUST be "add", not "create"
	assert.equal(changes[0].newText, "console.log('hello');");
});

test("buildToolItemShape maps 'edit' tool to BB compliant fileChange with kind: 'update' and granular edits", () => {
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
	const changes = shape.changes as Array<Record<string, unknown>>;
	assert.ok(Array.isArray(changes));
	assert.equal(changes.length, 2);
	assert.equal(changes[0].path, "/Users/vanya/test.ts");
	assert.equal(changes[0].kind, "update"); // MUST be "update", not "modify"
	assert.equal(changes[0].oldText, "foo");
	assert.equal(changes[0].newText, "bar");
	assert.equal(changes[1].path, "/Users/vanya/test.ts");
	assert.equal(changes[1].kind, "update");
	assert.equal(changes[1].oldText, "baz");
	assert.equal(changes[1].newText, "qux");
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
	assert.equal((start.shape.changes as any)[0].kind, "update");

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
	assert.equal(end.item?.type, "fileChange");
	assert.equal((end.item?.changes as any)[0].kind, "update");
});
