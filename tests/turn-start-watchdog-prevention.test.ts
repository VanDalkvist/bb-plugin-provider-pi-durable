import test from "node:test";
import assert from "node:assert/strict";
import { handleTurnStart } from "../src/host/bridge-router.ts";
import { SessionRegistry } from "../src/host/session-registry.ts";
import { sessionFixture } from "./fixtures/mirror.ts";

test("handleTurnStart: emits turn.open immediately on root turn input acceptance to disarm watchdog", async () => {
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	const results: Array<{ id: string | number; result: Record<string, unknown> }> = [];

	let promptCalled = false;
	const mockSession = sessionFixture({
		runner: { exited: false },
		options: { threadId: "thr_root_1" },
		prompt: async () => {
			promptCalled = true;
		},
	});

	const registry = new SessionRegistry(() => {});
	registry.track("thr_root_1", mockSession);

	const ctx = {
		registry,
		sendNotification: (method: string, params: Record<string, unknown>) => notifications.push({ method, params }),
		sendResult: (id: string | number, result: Record<string, unknown>) => results.push({ id, result }),
		sendError: () => {},
	};

	await handleTurnStart("req_root_1", {
		threadId: "thr_root_1",
		input: [{ type: "text", text: "Hello while subagent is running" }],
		clientRequestId: "creq_23456789ab",
	}, ctx);

	assert.equal(results.length, 1, "Result must be acknowledged");
	assert.equal(results[0].id, "req_root_1");
	assert.ok(promptCalled, "session.prompt must be called");

	const rootDeltas = notifications
		.filter((n) => n.method === "thread/delta" && n.params.threadId === "thr_root_1")
		.flatMap((n) => n.params.deltas as any[]);

	assert.ok(rootDeltas.some((d) => d.kind === "input.accepted"), "Must emit input.accepted");
	assert.ok(rootDeltas.some((d) => d.kind === "turn.open"), "Must emit turn.open immediately on root turn");
});
