import test from "node:test";
import assert from "node:assert/strict";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import {
	buildToolItemShape,
	translateToolStart,
	translateToolEnd,
} from "../src/host/tool-delta-translator.ts";

test("buildToolItemShape maps 'subagent' tool to BB compliant delegation shape", () => {
	// Standard short task
	const shortShape = buildToolItemShape(
		"subagent",
		{ task: "Investigate database performance" },
		"/Users/vanya",
	);
	assert.equal(shortShape.type, "delegation");
	assert.equal(shortShape.childRef, "subagent");
	assert.equal(shortShape.label, "Investigate database performance");
	assert.equal(shortShape.background, true);
	assert.equal(shortShape.summary, "Investigate database performance");

	// Long task (> 80 characters) truncation for label, full for summary
	const longTask = "A".repeat(95);
	const longShape = buildToolItemShape(
		"subagent",
		{ task: longTask },
		"/Users/vanya",
	);
	assert.equal(longShape.type, "delegation");
	assert.equal(longShape.label.length, 80);
	assert.ok(longShape.label.endsWith("..."));
	assert.equal(longShape.label, `${"A".repeat(77)}...`);
	assert.equal(longShape.summary, longTask);

	// Missing / empty task fallback
	const emptyShape = buildToolItemShape("subagent", {}, "/Users/vanya");
	assert.equal(emptyShape.type, "delegation");
	assert.equal(emptyShape.label, "Subagent delegation");
	assert.equal(emptyShape.childRef, "subagent");
	assert.equal(emptyShape.background, true);
	assert.equal(emptyShape.summary, undefined);

	// Explicit conversationId in args
	const customConvShape = buildToolItemShape(
		"subagent",
		{ task: "Subtask", conversationId: "conv-sub-1" },
		"/Users/vanya",
	);
	assert.equal(customConvShape.childRef, "conv-sub-1");

	// Explicit childRef fallback in args
	const customChildRefShape = buildToolItemShape(
		"subagent",
		{ task: "Subtask", childRef: "child-ref-2" },
		"/Users/vanya",
	);
	assert.equal(customChildRefShape.childRef, "child-ref-2");
});

test("buildToolItemShape maps 'agent_spawn' tool to BB compliant delegation shape", () => {
	const spawnShape = buildToolItemShape(
		"agent_spawn",
		{ name: "reviewer", task: "Review architecture rules" },
		"/Users/vanya",
	);
	assert.equal(spawnShape.type, "delegation");
	assert.equal(spawnShape.childRef, "reviewer");
	assert.equal(spawnShape.label, "Review architecture rules");
	assert.equal(spawnShape.summary, "Review architecture rules");

	const spawnDefault = buildToolItemShape("agent_spawn", {}, "/Users/vanya");
	assert.equal(spawnDefault.type, "delegation");
	assert.equal(spawnDefault.childRef, "agent");
	assert.equal(spawnDefault.label, "Agent delegation");
});

test("buildToolItemShape maps 'agent_spawn_graph' tool to BB compliant delegation shape", () => {
	const graphShape = buildToolItemShape(
		"agent_spawn_graph",
		{
			name: "audit-pipeline",
			agents: [
				{ name: "scanner", task: "Scan vulnerabilities" },
				{ name: "reporter", task: "Generate report" },
			],
		},
		"/Users/vanya",
	);
	assert.equal(graphShape.type, "delegation");
	assert.equal(graphShape.childRef, "audit-pipeline");
	assert.ok(graphShape.label.includes("audit-pipeline") || graphShape.label.includes("Graph"));
});

test("preserves existing tool contracts for bash, write, and edit", () => {
	// 1. bash command
	const bashStart = translateToolStart(
		{
			type: "tool_execution_start",
			toolCallId: "call_bash",
			toolName: "bash",
			args: { command: "git status" },
		},
		"/Users/vanya",
	);
	assert.equal(bashStart.shape.type, "command");
	assert.equal(bashStart.delta.presentation, undefined);
	assert.equal(threadDeltaSchema.safeParse(bashStart.delta).success, true);

	const bashEnd = translateToolEnd(
		{
			type: "tool_execution_end",
			toolCallId: "call_bash",
			toolName: "bash",
			result: "On branch main",
			isError: false,
		},
		bashStart.shape,
		"/Users/vanya",
	);
	assert.equal(bashEnd.status, "completed");
	assert.equal(bashEnd.presentation, undefined);
	assert.equal(threadDeltaSchema.safeParse(bashEnd).success, true);

	// 2. write fileChange
	const writeStart = translateToolStart(
		{
			type: "tool_execution_start",
			toolCallId: "call_write",
			toolName: "write",
			args: { path: "/file.txt", content: "data" },
		},
		"/Users/vanya",
	);
	assert.equal(writeStart.shape.type, "fileChange");
	assert.equal(writeStart.delta.presentation, undefined);
	assert.equal(threadDeltaSchema.safeParse(writeStart.delta).success, true);

	// 3. edit fileChange
	const editStart = translateToolStart(
		{
			type: "tool_execution_start",
			toolCallId: "call_edit",
			toolName: "edit",
			args: { path: "/file.txt", edits: [{ oldText: "a", newText: "b" }] },
		},
		"/Users/vanya",
	);
	assert.equal(editStart.shape.type, "fileChange");
	assert.equal(threadDeltaSchema.safeParse(editStart.delta).success, true);

	// 4. foreground subagent presentation (background: false)
	const fgStart = translateToolStart(
		{
			type: "tool_execution_start",
			toolCallId: "call_sub_fg",
			toolName: "subagent",
			args: { task: "Sync work", background: false },
		},
		"/Users/vanya",
	);
	assert.deepEqual(fgStart.delta.presentation?.label, {
		pending: "Running subagent",
		completed: "Subagent completed",
	});

	// 5. graph delegation presentation
	const graphStart = translateToolStart(
		{
			type: "tool_execution_start",
			toolCallId: "call_graph",
			toolName: "agent_spawn_graph",
			args: { name: "review-flow" },
		},
		"/Users/vanya",
	);
	assert.deepEqual(graphStart.delta.presentation?.label, {
		pending: "Starting background subagent",
		completed: "Started background subagent",
	});
});
