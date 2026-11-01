import test from "node:test";
import assert from "node:assert/strict";
import {
	formatSubagentMirrorPrompt,
	parseSubagentMirrorPrompt,
} from "../src/shared/subagent-envelope.ts";

test("formatSubagentMirrorPrompt generates sovereign pi prefix", () => {
	const formatted = formatSubagentMirrorPrompt("session-1", "parent-1", "2", "Do work");
	assert.ok(formatted.startsWith("[pi:subagent-mirror:v1 session=session-1 parent=parent-1 conv=2]"));
});

test("parseSubagentMirrorPrompt parses both sovereign pi and legacy bb prefixes", () => {
	// Sovereign format
	const piPrompt = "[pi:subagent-mirror:v1 session=sess-1 parent=p-1 conv=2]\nTask for subagent";
	const parsedPi = parseSubagentMirrorPrompt(piPrompt);
	assert.equal(parsedPi.isMirror, true);
	if (parsedPi.isMirror) {
		assert.equal(parsedPi.sessionKey, "sess-1");
		assert.equal(parsedPi.parentThreadId, "p-1");
		assert.equal(parsedPi.conversationId, "2");
		assert.equal(parsedPi.task, "Task for subagent");
	}

	// Legacy BB format
	const bbPrompt = "[bb:pi-subagent-mirror:v1 session=sess-2 parent=p-2 conv=3]\nLegacy task";
	const parsedBb = parseSubagentMirrorPrompt(bbPrompt);
	assert.equal(parsedBb.isMirror, true);
	if (parsedBb.isMirror) {
		assert.equal(parsedBb.sessionKey, "sess-2");
		assert.equal(parsedBb.parentThreadId, "p-2");
		assert.equal(parsedBb.conversationId, "3");
		assert.equal(parsedBb.task, "Legacy task");
	}
});
