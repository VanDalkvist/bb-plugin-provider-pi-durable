import test from "node:test";
import assert from "node:assert/strict";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import {
	translateToolStart,
	translateToolEnd,
} from "../src/host/tool-delta-translator.ts";

test("translateToolStart emits item.open with delegation shape and Bot icon presentation", () => {
	const start = translateToolStart(
		{
			type: "tool_execution_start",
			toolCallId: "call_sub_start_1",
			toolName: "subagent",
			args: { task: "Run lint and review code changes" },
		},
		"/Users/vanya",
	);

	assert.equal(start.delta.kind, "item.open");
	assert.deepEqual(start.delta.key, { providerItemId: "call_sub_start_1" });
	assert.equal(start.shape.type, "delegation");
	assert.equal(start.shape.label, "Run lint and review code changes");
	assert.equal(start.shape.childRef, "subagent");
	assert.equal(start.shape.background, true);

	const presentation = start.delta.presentation as Record<string, unknown>;
	assert.ok(presentation, "presentation must be present for delegation item.open");
	assert.deepEqual(presentation.icon, { glyph: "Bot" });
	assert.deepEqual(presentation.label, {
		pending: "Starting background subagent",
		completed: "Started background subagent",
	});
	assert.equal(presentation.title, "Run lint and review code changes");

	// Wire contract validation
	const parseResult = threadDeltaSchema.safeParse(start.delta);
	assert.equal(parseResult.success, true, "item.open delta must conform to threadDeltaSchema");
});

test("translateToolEnd updates childRef from event.details.conversationId and completes delegation", () => {
	const start = translateToolStart(
		{
			type: "tool_execution_start",
			toolCallId: "call_sub_end_1",
			toolName: "subagent",
			args: { task: "Perform architectural review" },
		},
		"/Users/vanya",
	);

	const endDelta = translateToolEnd(
		{
			type: "tool_execution_end",
			toolCallId: "call_sub_end_1",
			toolName: "subagent",
			result: "Architectural review finished: 0 findings.",
			isError: false,
			details: { conversationId: "conv-resolved-42" },
		},
		start.shape,
		"/Users/vanya",
	);

	assert.equal(endDelta.kind, "item.close");
	assert.equal(endDelta.status, "completed");
	assert.equal(endDelta.exitCode, 0);
	assert.equal(endDelta.error, undefined);
	assert.equal(endDelta.resultText, "Architectural review finished: 0 findings.");

	const item = endDelta.item as Record<string, unknown>;
	assert.equal(item.type, "delegation");
	assert.equal(item.childRef, "conv-resolved-42");
	assert.equal(item.label, "Perform architectural review");
	assert.equal(item.summary, "Architectural review finished: 0 findings.");
	assert.equal(item.background, true);

	const presentation = endDelta.presentation as Record<string, unknown>;
	assert.ok(presentation, "presentation must be preserved on item.close for delegation");
	assert.deepEqual(presentation.icon, { glyph: "Bot" });
	assert.deepEqual(presentation.label, {
		pending: "Starting background subagent",
		completed: "Started background subagent",
	});

	// Truncation check for result text > 300 characters
	const longResult = "Summary: " + "X".repeat(350);
	const longEndDelta = translateToolEnd(
		{
			type: "tool_execution_end",
			toolCallId: "call_sub_end_long",
			toolName: "subagent",
			result: longResult,
			isError: false,
			details: { conversationId: "conv-long-99" },
		},
		start.shape,
		"/Users/vanya",
	);
	const longItem = longEndDelta.item as Record<string, unknown>;
	assert.ok(typeof longItem.summary === "string");
	assert.equal((longItem.summary as string).length, 300);
	assert.ok((longItem.summary as string).endsWith("..."));

	// Wire contract validation
	const parseResult = threadDeltaSchema.safeParse(endDelta);
	assert.equal(parseResult.success, true, "completed delegation delta must conform to threadDeltaSchema");
	const parseLongResult = threadDeltaSchema.safeParse(longEndDelta);
	assert.equal(parseLongResult.success, true, "long summary delegation delta must conform to threadDeltaSchema");
});

test("translateToolEnd handles subagent execution failure", () => {
	const start = translateToolStart(
		{
			type: "tool_execution_start",
			toolCallId: "call_sub_err_1",
			toolName: "subagent",
			args: { task: "Generate complex schema" },
		},
		"/Users/vanya",
	);

	const errorEndDelta = translateToolEnd(
		{
			type: "tool_execution_end",
			toolCallId: "call_sub_err_1",
			toolName: "subagent",
			result: "Subagent execution timed out after 60s",
			isError: true,
			details: { conversationId: "conv-failed-1" },
		},
		start.shape,
		"/Users/vanya",
	);

	assert.equal(errorEndDelta.kind, "item.close");
	assert.equal(errorEndDelta.status, "failed");
	assert.equal(errorEndDelta.exitCode, 1);
	assert.deepEqual(errorEndDelta.error, { message: "Subagent execution timed out after 60s" });

	const item = errorEndDelta.item as Record<string, unknown>;
	assert.equal(item.type, "delegation");
	assert.equal(item.childRef, "conv-failed-1");
	assert.equal(item.summary, "Subagent execution timed out after 60s");

	const presentation = errorEndDelta.presentation as Record<string, unknown>;
	assert.deepEqual(presentation.icon, { glyph: "Bot" });

	const parseResult = threadDeltaSchema.safeParse(errorEndDelta);
	assert.equal(parseResult.success, true, "failed delegation delta must conform to threadDeltaSchema");
});
