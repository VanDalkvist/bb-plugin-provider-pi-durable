import test from "node:test";
import assert from "node:assert/strict";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { handleTurnStart, type BridgeRouterContext, type TurnStartParams } from "../src/host/bridge-router.ts";
import { SubagentMirrorManager } from "../src/host/subagent-mirror.ts";
import { SessionRegistry } from "../src/host/session-registry.ts";
import type { PiThreadSession } from "../src/host/session.ts";

test("Slice 6.2: Early completion race emits turn.open, accumulated text, turn.boundary, and cleans up memory", async () => {
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	const results: Array<{ id: string | number; result: Record<string, unknown> }> = [];
	const errors: Array<{ id: string | number; code: number; message: string }> = [];

	// 1. Real SubagentMirrorManager tracks the subagent lifecycle
	const mirrors = new SubagentMirrorManager();

	// Subagent starts running
	mirrors.markActive("99", { task: "Perform instant audit", parentToolCallId: "call_sub_fast" });
	assert.equal(mirrors.getState("99")?.status, "running");

	// Subagent streams output text
	mirrors.appendOutputText("99", "Audit completed in 15ms. All green.");

	// Subagent finishes early (within 20ms) before BB server has spawned the child thread
	mirrors.markCompleted("99", "Audit completed in 15ms. All green.");
	assert.equal(mirrors.getState("99")?.status, "completed");
	assert.equal(mirrors.getOutputText("99"), "Audit completed in 15ms. All green.");

	// 2. Mock session connected to real SubagentMirrorManager
	let registeredBinding: { threadId: string; conversationId?: string } | undefined;
	const mockSession = {
		options: { threadId: "thr_parent", providerThreadId: "pi_durable_root:1" },
		runner: { exited: false },
		findSubagentConversationForTask: (task: string) => mirrors.findConversationForTask(task),
		getSubagentState: (id: string | number) => mirrors.getState(id),
		getMirrorOutputText: (id: string | number) => mirrors.getOutputText(id),
		consumeCompletedMirror: (id: string | number) => mirrors.consumeCompleted(id),
		registerThread: (threadId: string, conversationId?: string) => {
			registeredBinding = { threadId, conversationId };
		},
		getConversationIdForThread: (_threadId: string) => undefined,
	} as unknown as PiThreadSession;

	const registry = new SessionRegistry(() => {});
	(registry as unknown as { sessions: Map<string, PiThreadSession> }).sessions.set("thr_parent", mockSession);
	(registry as unknown as { sessions: Map<string, PiThreadSession> }).sessions.set("thr_child_fast", mockSession);

	const ctx: BridgeRouterContext = {
		registry,
		sendNotification: (method, params) => notifications.push({ method, params }),
		sendResult: (id, result) => results.push({ id, result }),
		sendError: (id, code, message) => errors.push({ id, code, message }),
	};

	// 3. BB server finally finishes spawn and sends turn/start for the child thread
	const turnParams: TurnStartParams = {
		threadId: "thr_child_fast",
		parentThreadId: "thr_parent",
		input: [{ type: "text", text: "Perform instant audit" }],
		clientRequestId: "creq_23456789ab",
	};

	await handleTurnStart("req_turn_early", turnParams, ctx);

	// 4. Result was sent acknowledging the request
	assert.equal(results.length, 1);
	assert.equal(results[0].id, "req_turn_early");
	assert.deepEqual(registeredBinding, { threadId: "thr_child_fast", conversationId: "99" });

	// 5. Notifications must include input.accepted and completion deltas
	const childNotifs = notifications.filter((n) => n.params.threadId === "thr_child_fast");
	assert.ok(childNotifs.length >= 2, "Expected input.accepted and completion deltas");

	// Flatten deltas
	const allDeltas = childNotifs.flatMap((n) => (n.params.deltas as any[]) || []);

	// Validate every delta against threadDeltaSchema
	for (const delta of allDeltas) {
		const parsed = threadDeltaSchema.safeParse(delta);
		assert.ok(parsed.success, `Delta ${JSON.stringify(delta)} must satisfy threadDeltaSchema: ${parsed.error}`);
	}

	// First delta: input.accepted
	assert.equal(allDeltas[0].kind, "input.accepted");
	assert.equal(allDeltas[0].clientRequestId, "creq_23456789ab");

	// Watchdog safeguard: turn.open
	const turnOpenIndex = allDeltas.findIndex((d) => d.kind === "turn.open");
	assert.ok(turnOpenIndex > 0, "turn.open must be emitted to prevent 120s watchdog timeout");

	// Full accumulated text delivered via textDelta and textClose
	const textDelta = allDeltas.find((d) => d.kind === "item.textDelta");
	assert.ok(textDelta, "item.textDelta must be emitted with accumulated text");
	assert.equal(textDelta.text, "Audit completed in 15ms. All green.");

	const textClose = allDeltas.find((d) => d.kind === "item.textClose");
	assert.ok(textClose, "item.textClose must be emitted");
	assert.equal(textClose.text, "Audit completed in 15ms. All green.");

	// Boundary finalized with status completed
	const boundary = allDeltas.find((d) => d.kind === "turn.boundary");
	assert.ok(boundary, "turn.boundary must be emitted");
	assert.equal(boundary.status, "completed");

	// 6. Memory cleanup: consumeCompleted must have pruned the completed mirror
	assert.equal(mirrors.getState("99"), undefined, "Completed mirror must be pruned from memory");
	assert.equal(mirrors.findConversationForTask("Perform instant audit"), undefined, "Task mapping must be pruned");
});
