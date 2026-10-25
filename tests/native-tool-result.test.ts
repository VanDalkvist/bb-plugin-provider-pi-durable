import test from "node:test";
import assert from "node:assert/strict";
import { captureNativeToolEnds } from "./native-tool-events.fixture.ts";
import { ToolEventProjector } from "../src/runner/bridge/tool-result-extractor.ts";
import { extractCanonicalToolDetails } from "../src/runner/bridge/native-tool-result.ts";
import { presentToolResult } from "../src/runner/bridge/tool-result-presentation.ts";

test("Slice 1: captureNativeToolEnds captures genuine SDK events and maps cleanly", async () => {
	const { leafEnd, badleafEnd, batchEnd } = await captureNativeToolEnds();
	const p = new ToolEventProjector();

	const leafWire = p.projectToolEnd(leafEnd as any);
	assert.equal(leafWire.isError, false, "Nested leaf tool should succeed");
	assert.equal(leafWire.result, "leaf ok");
	assert.deepEqual(leafWire.details, { diff: "-old\n+new", patch: "@@ -1 +1 @@\n-old\n+new" });

	const badleafWire = p.projectToolEnd(badleafEnd as any);
	assert.equal(badleafWire.isError, true, "Nested badleaf tool should fail");
	assert.match(badleafWire.result, /native failure/);

	const batchWire = p.projectToolEnd(batchEnd as any);
	assert.equal(batchWire.isError, false, "Parent batch tool should succeed");
	assert.deepEqual(batchWire.details, { conversationId: 77 });
});

test("Slice 1: Terminal result handles falsey scalar structuredOutput correctly", () => {
	const p = new ToolEventProjector();
	const checkOutput = (val: unknown, expected: string) => {
		const wire = p.projectToolEnd({
			type: "tool_execution_end",
			toolCallId: "c",
			toolName: "t",
			result: { taskId: "t" as any, structuredOutput: val, isError: false, diagnostics: [] },
		} as any);
		assert.equal(wire.isError, false);
		assert.equal(wire.result, expected);
	};
	checkOutput(0, "0");
	checkOutput(false, "false");
	checkOutput(null, "null");
	checkOutput("", "");
});

test("Feedback Item 4 RED: Generic JSON with data or mimeType property must not be corrupted into image", () => {
	// A generic MCP / API payload that happens to have a field named "data"
	const customerRecord = {
		data: "customer-record-id-12345",
		status: "active",
		count: 42,
	};
	const rendered = presentToolResult({
		toolName: "get_customer",
		rawOutput: customerRecord,
		isError: false,
	});

	assert.ok(
		!rendered.includes("[image:"),
		`Generic JSON with 'data' string must NOT be formatted as an image descriptor, got: ${rendered}`,
	);
	assert.ok(rendered.includes('"data": "customer-record-id-12345"'));
	assert.ok(rendered.includes('"status": "active"'));
});

test("Feedback Item 4 RED: Nested image in structured JSON redacts base64 but preserves siblings", () => {
	const payloadWithImage = {
		title: "Scan Report",
		scanId: 999,
		diagram: {
			type: "image",
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
		},
	};
	const rendered = presentToolResult({
		toolName: "scan",
		rawOutput: payloadWithImage,
		isError: false,
	});

	assert.ok(!rendered.includes("iVBORw0KGgoAAAANSUhEUgAAAAE"), "Base64 string must be redacted");
	assert.ok(rendered.includes('"title": "Scan Report"'), "Sibling field title must be preserved");
	assert.ok(rendered.includes('"scanId": 999'), "Sibling field scanId must be preserved");
	assert.ok(rendered.includes("image/png"), "mimeType must be preserved");
});

test("Slice 1: extractCanonicalToolDetails never returns entry.data envelope", () => {
	const entryEvent = {
		type: "tool_execution_end",
		entry: {
			id: "e1",
			conversationId: "c1",
			kind: "toolResult",
			data: { diagnostics: [] },
			model: [{ role: "toolResult", details: { conversationId: 88, diff: "diff" } }],
		},
	};
	assert.deepEqual(extractCanonicalToolDetails(entryEvent), { conversationId: 88, diff: "diff" });

	const resultEvent = {
		type: "tool_execution_end",
		result: { taskId: "t1", details: { patch: "patch" } },
	};
	assert.deepEqual(extractCanonicalToolDetails(resultEvent), { patch: "patch" });
	assert.equal(extractCanonicalToolDetails({ type: "tool_execution_end", entry: { data: {} } }), undefined);
});
