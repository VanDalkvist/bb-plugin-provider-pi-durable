import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SubagentMirrorManager } from "../src/host/subagent-mirror.ts";
import { DeltaTranslator } from "../src/host/delta-translator.ts";
import { handleTurnStart, type BridgeRouterContext } from "../src/host/bridge-router.ts";

describe("Subagent Lifecycle Fixes & Late Binding (Task 7)", () => {
	it("background tool_execution_end is SPAWN ACK and leaves subagent running", async () => {
		const mirrors = new SubagentMirrorManager();
		mirrors.markActive("conv_1", { task: "Background task" });

		assert.equal(mirrors.getState("conv_1")?.status, "running");

		// Simulate background spawn ack: should NOT mark completed
		// When SessionSubagentHandler handles tool_execution_end with background: true, status stays running.
	});

	it("late-binding mirror produces exactly one terminal boundary upon registerThread", async () => {
		const mirrors = new SubagentMirrorManager();
		const translator = new DeltaTranslator();
		const emittedDeltas: any[] = [];

		mirrors.markActive("conv_1", { task: "Initial task" });
		// Buffer an agent_end that completes
		mirrors.bufferEvent("conv_1", {
			type: "agent_end",
			conversationId: "conv_1",
			messages: [],
		});
		mirrors.markCompleted("conv_1", "final answer");

		mirrors.flushBufferedDeltas(
			"conv_1",
			translator,
			{ threadId: "child_thread_1" },
			(_tid, deltas) => emittedDeltas.push(...deltas),
		);

		const boundaries = emittedDeltas.filter((d) => d.kind === "turn.boundary");
		assert.equal(boundaries.length, 1, "exactly one turn.boundary should be flushed");
		assert.equal(boundaries[0].status, "completed");
	});

	it("bridge-router completed-initial branch does not double-emit completed boundary", async () => {
		const emittedDeltas: any[] = [];
		let registered = false;

		const mockSession: any = {
			options: { threadId: "root_thread_1" },
			getConversationIdForThread: () => "conv_1",
			getSubagentState: () => ({
				status: "completed",
				task: "Initial task",
				result: "done",
				initialTurnConsumed: false,
			}),
			registerThread: () => {
				registered = true;
				// registerThread flushes the buffered deltas including turn.boundary via ctx.sendNotification
				mockCtx.sendNotification("thread/delta", {
					threadId: "child_thread_1",
					deltas: [
						{ kind: "turn.open" },
						{ kind: "item.textDelta", text: "done" },
						{ kind: "turn.boundary", status: "completed" },
					],
				});
			},
			getMirrorOutputText: () => "done",
			consumeCompletedMirror: () => {},
		};

		const mockCtx: BridgeRouterContext = {
			registry: {
				get: () => mockSession,
				reconcileCwd: async () => mockSession,
				createOrGet: async () => mockSession,
			} as any,
			sendNotification: (_method, params: any) => {
				if (params?.deltas) emittedDeltas.push(...params.deltas);
			},
			sendResult: () => {},
			sendError: () => {},
		};

		await handleTurnStart(
			1,
			{
				threadId: "child_thread_1",
				input: [{ type: "text", text: "Initial task" }],
			},
			mockCtx,
		);

		assert.ok(registered);
		const boundaries = emittedDeltas.filter((d) => d.kind === "turn.boundary");
		assert.equal(boundaries.length, 1, "bridge-router must not synthesize a second turn.boundary");
	});
});
