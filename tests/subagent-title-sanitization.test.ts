import test from "node:test";
import assert from "node:assert/strict";
import { nativeChildTitle } from "../src/shared/child-title.ts";
import { BBChildEventAdapter } from "../src/runner/bridge/bb-child-event-adapter.ts";
import { buildSpawnArgs } from "../src/host/subthread-spawner.ts";
import type { BBWireEvent } from "../src/runner/bridge/contracts.ts";
import type { AgentEvent } from "@earendil-works/pi-durable";

test("nativeChildTitle: strips control characters and collapses whitespace", () => {
	const raw = "fix\u0000\u0007bug\u001b\n\r\tin\u007fauth\u009fcontroller";
	const sanitized = nativeChildTitle(raw);
	assert.equal(sanitized, "fix bug in auth controller");
	assert.doesNotMatch(sanitized, /[\u0000-\u001f\u007f-\u009f]/u);
});

test("nativeChildTitle: strips bidi characters", () => {
	const raw = "subagent\u200e \u200fwith\u061c \u202eRLO\u202c and\u2066isolate\u2069";
	const sanitized = nativeChildTitle(raw);
	assert.equal(sanitized, "subagent with RLO and isolate");
	assert.doesNotMatch(sanitized, /[\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u);
});

test("nativeChildTitle: field length clipping and formatting", () => {
	const longName = "a".repeat(200);
	const longRole = "b".repeat(50);
	const longModel = "c".repeat(60);

	const result = nativeChildTitle(longName, longRole, { provider: "provider", modelId: longModel });
	const parts = result.split(" · ");

	assert.equal(parts.length, 3);
	assert.equal(parts[0], "a".repeat(180));
	assert.equal(parts[1], "b".repeat(24));
	assert.equal(parts[2], ("provider/" + longModel).slice(0, 40));
});

test("nativeChildTitle: total length ceiling <= 494 UTF-16 units with astral characters", () => {
	const name = "🎉".repeat(300);
	const role = "🔥".repeat(100);
	const model = { provider: "🚀".repeat(50), modelId: "🌟".repeat(50) };

	const title = nativeChildTitle(name, role, model);
	assert.ok(title.length <= 494, `Title length ${title.length} exceeds 494 UTF-16 code units`);
	assert.ok(title.includes(" · "));
});

test("buildSpawnArgs: sanitizes title using nativeChildTitle", () => {
	const origEnv = process.env.BB_ENVIRONMENT_ID;
	delete process.env.BB_ENVIRONMENT_ID;
	try {
		const args = buildSpawnArgs({
			projectId: "proj_personal",
			parentThreadId: "thr_parent_123",
			title: "Dangerous\u0000\u202e\n Title " + "x".repeat(300),
			task: "Execute safely",
		});

		const titleIndex = args.indexOf("--title");
		assert.ok(titleIndex !== -1, "Must contain --title flag");
		const sanitizedTitle = args[titleIndex + 1];

		assert.doesNotMatch(sanitizedTitle, /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u);
		assert.ok(sanitizedTitle.length <= 180);
		assert.equal(sanitizedTitle, "Dangerous Title " + "x".repeat(164));
	} finally {
		if (origEnv !== undefined) process.env.BB_ENVIRONMENT_ID = origEnv;
	}
});

test("BBChildEventAdapter message_end flush: flushes unsent tail chunk without duplicating existing text", () => {
	const emitted: BBWireEvent[] = [];
	const adapter = new BBChildEventAdapter((ev) => emitted.push(ev), "parent_call_1", 42);

	// 1. Partial streaming via message_update text_delta
	adapter.handleEvent({
		type: "message_update",
		usage: { input: 10, output: 5, totalTokens: 15 } as any,
		changes: [
			{ type: "text_delta", contentIndex: 0, delta: "Hello " },
		],
	} as AgentEvent);

	assert.equal(emitted.length, 1);
	assert.equal(emitted[0].type, "message_update");
	if (emitted[0].type === "message_update") {
		assert.equal(emitted[0].assistantMessageEvent.type, "text_delta");
		assert.equal((emitted[0].assistantMessageEvent as any).delta, "Hello ");
	}

	// 2. On message_end, AssistantEntry has full text "Hello world! Done."
	const assistantEntry = {
		id: 101,
		conversationId: 42,
		kind: "pi.assistant",
		model: [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Hello world! Done." },
				],
			},
		],
	};

	adapter.handleEvent({
		type: "message_end",
		entry: assistantEntry,
	} as unknown as AgentEvent);

	// The missing tail "world! Done." must be flushed
	const deltas = emitted
		.filter((e) => e.type === "message_update" && e.assistantMessageEvent.type === "text_delta")
		.map((e) => (e as any).assistantMessageEvent.delta);

	assert.deepEqual(deltas, ["Hello ", "world! Done."]);

	// 3. Subsequent message_end when fully streamed should not emit any duplicates
	adapter.handleEvent({
		type: "message_update",
		usage: { input: 10, output: 10, totalTokens: 20 } as any,
		changes: [
			{ type: "text_delta", contentIndex: 0, delta: "All tokens streamed." },
		],
	} as AgentEvent);

	const fullyStreamedEntry = {
		id: 102,
		conversationId: 42,
		kind: "pi.assistant",
		model: [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "All tokens streamed." },
				],
			},
		],
	};

	adapter.handleEvent({
		type: "message_end",
		entry: fullyStreamedEntry,
	} as unknown as AgentEvent);

	const allDeltas = emitted
		.filter((e) => e.type === "message_update" && e.assistantMessageEvent.type === "text_delta")
		.map((e) => (e as any).assistantMessageEvent.delta);

	assert.deepEqual(allDeltas, ["Hello ", "world! Done.", "All tokens streamed."]);
});

test("BBChildEventAdapter message_end flush: flushes entire text when no deltas were streamed", () => {
	const emitted: BBWireEvent[] = [];
	const adapter = new BBChildEventAdapter((ev) => emitted.push(ev), "parent_call_2", 99);

	const unstreamedEntry = {
		id: 201,
		conversationId: 99,
		kind: "pi.assistant",
		model: [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Instant non-streamed response." },
				],
			},
		],
	};

	adapter.handleEvent({
		type: "message_end",
		entry: unstreamedEntry,
	} as unknown as AgentEvent);

	const deltas = emitted
		.filter((e) => e.type === "message_update" && e.assistantMessageEvent.type === "text_delta")
		.map((e) => (e as any).assistantMessageEvent.delta);

	assert.deepEqual(deltas, ["Instant non-streamed response."]);
});
