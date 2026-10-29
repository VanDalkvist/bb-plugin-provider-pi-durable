import test from "node:test";
import assert from "node:assert/strict";
import {
	formatSubagentMirrorPrompt,
	parseSubagentMirrorPrompt,
	stripSubagentMirrorEnvelope,
	InvalidSubagentMirrorEnvelopeError,
} from "../src/shared/subagent-envelope.ts";

test("formatSubagentMirrorPrompt formats explicit versioned envelope with session, parent, conv, and task", () => {
	const prompt = formatSubagentMirrorPrompt(
		"pi_durable_session_root",
		"thr_parent_123",
		"456",
		"Analyze memory leaks",
	);
	assert.match(
		prompt,
		/^\[bb:pi-subagent-mirror:v1 session=pi_durable_session_root parent=thr_parent_123 conv=456\]\nAnalyze memory leaks$/,
	);
});

test("formatSubagentMirrorPrompt formats numeric conversation IDs cleanly", () => {
	const prompt = formatSubagentMirrorPrompt(
		"session_abc",
		"thr_parent_999",
		2,
		"Run tests in parallel",
	);
	assert.equal(
		prompt,
		"[bb:pi-subagent-mirror:v1 session=session_abc parent=thr_parent_999 conv=2]\nRun tests in parallel",
	);
});

test("parseSubagentMirrorPrompt detects and extracts envelope and task", () => {
	const raw = "[bb:pi-subagent-mirror:v1 session=session_root parent=thr_parent_abc conv=3]\nLine 1 of task\nLine 2 of task";
	const parsed = parseSubagentMirrorPrompt(raw);
	assert.equal(parsed.isMirror, true);
	if (parsed.isMirror) {
		assert.equal(parsed.sessionKey, "session_root");
		assert.equal(parsed.parentThreadId, "thr_parent_abc");
		assert.equal(parsed.conversationId, "3");
		assert.equal(parsed.task, "Line 1 of task\nLine 2 of task");
	}
});

test("parseSubagentMirrorPrompt handles whitespace gracefully", () => {
	const raw = "  [bb:pi-subagent-mirror:v1 session=s_123 parent=thr_p conv=42]  \n\nActual task text   ";
	const parsed = parseSubagentMirrorPrompt(raw);
	assert.equal(parsed.isMirror, true);
	if (parsed.isMirror) {
		assert.equal(parsed.sessionKey, "s_123");
		assert.equal(parsed.parentThreadId, "thr_p");
		assert.equal(parsed.conversationId, "42");
		assert.equal(parsed.task, "Actual task text");
	}
});

test("parseSubagentMirrorPrompt returns isMirror: false for ordinary prompts not using reserved prefix", () => {
	const ordinary = "Please review this pull request and write comments.";
	const parsed = parseSubagentMirrorPrompt(ordinary);
	assert.equal(parsed.isMirror, false);
	assert.equal(parsed.task, ordinary);
});

test("parseSubagentMirrorPrompt throws InvalidSubagentMirrorEnvelopeError for reserved prefix with invalid schema or unsupported version", () => {
	// Wrong version
	assert.throws(
		() => parseSubagentMirrorPrompt("[bb:pi-subagent-mirror:v2 session=s parent=thr_1 conv=2]\nTask"),
		InvalidSubagentMirrorEnvelopeError,
	);

	// Missing session
	assert.throws(
		() => parseSubagentMirrorPrompt("[bb:pi-subagent-mirror:v1 parent=thr_1 conv=2]\nTask"),
		InvalidSubagentMirrorEnvelopeError,
	);

	// Missing parent
	assert.throws(
		() => parseSubagentMirrorPrompt("[bb:pi-subagent-mirror:v1 session=s conv=2]\nTask"),
		InvalidSubagentMirrorEnvelopeError,
	);

	// Root conversation id (conv=1 or numeric aliases) is forbidden
	assert.throws(
		() => parseSubagentMirrorPrompt("[bb:pi-subagent-mirror:v1 session=s parent=thr_1 conv=1]\nTask"),
		InvalidSubagentMirrorEnvelopeError,
	);
	assert.throws(
		() => parseSubagentMirrorPrompt("[bb:pi-subagent-mirror:v1 session=s parent=thr_1 conv=01]\nTask"),
		InvalidSubagentMirrorEnvelopeError,
	);
	assert.throws(
		() => parseSubagentMirrorPrompt("[bb:pi-subagent-mirror:v1 session=s parent=thr_1 conv=0]\nTask"),
		InvalidSubagentMirrorEnvelopeError,
	);
	assert.throws(
		() => parseSubagentMirrorPrompt("[bb:pi-subagent-mirror:v1 session=s parent=thr_1 conv=conv_str]\nTask"),
		InvalidSubagentMirrorEnvelopeError,
	);

	// Traversal or unsafe dots in session key are forbidden
	assert.throws(
		() => parseSubagentMirrorPrompt("[bb:pi-subagent-mirror:v1 session=. parent=thr_1 conv=2]\nTask"),
		InvalidSubagentMirrorEnvelopeError,
	);
	assert.throws(
		() => parseSubagentMirrorPrompt("[bb:pi-subagent-mirror:v1 session=.. parent=thr_1 conv=2]\nTask"),
		InvalidSubagentMirrorEnvelopeError,
	);
	assert.throws(
		() => parseSubagentMirrorPrompt("[bb:pi-subagent-mirror:v1 session=../foo parent=thr_1 conv=2]\nTask"),
		InvalidSubagentMirrorEnvelopeError,
	);
	assert.throws(
		() => parseSubagentMirrorPrompt("[bb:pi-subagent-mirror:v1 session=foo..bar parent=thr_1 conv=2]\nTask"),
		InvalidSubagentMirrorEnvelopeError,
	);
});

test("parseSubagentMirrorPrompt permits safe dots in session key for .jsonl formats", () => {
	const parsed = parseSubagentMirrorPrompt("[bb:pi-subagent-mirror:v1 session=pi_durable_12345.jsonl parent=thr_1 conv=2]\nTask");
	assert.equal(parsed.isMirror, true);
	if (parsed.isMirror) {
		assert.equal(parsed.sessionKey, "pi_durable_12345.jsonl");
	}
});

test("stripSubagentMirrorEnvelope strips envelope if present and returns clean task", () => {
	const raw = "[bb:pi-subagent-mirror:v1 session=s_abc parent=thr_p conv=12]\nExecute security audit";
	const clean = stripSubagentMirrorEnvelope(raw);
	assert.equal(clean, "Execute security audit");

	const ordinary = "Ordinary prompt without header";
	assert.equal(stripSubagentMirrorEnvelope(ordinary), ordinary);
});
