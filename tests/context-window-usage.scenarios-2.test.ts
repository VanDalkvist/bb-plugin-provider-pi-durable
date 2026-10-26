import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RunnerProcess } from "../src/host/runner-process.ts";
import { PiThreadSession } from "../src/host/session.ts";
import { DeltaTranslator } from "../src/host/delta-translator.ts";
import { BBEventAdapter } from "../src/runner/bridge/bb-event-adapter.ts";
import type { DurableView } from "../src/runner/runtime-types.ts";
import type { BBWireEvent } from "../src/runner/bridge/contracts.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { viewFixture } from "./fixtures/durable.ts";
import { wireFixture } from "./fixtures/wire.ts";

describe("Context Window Telemetry & Usage Synchronization (Cycle 57)", () => {
    it("handleRunnerEvent('agent_end') refreshes context usage before finalizing the turn", async () => {
        const eventOrder: string[] = [];
        const notifications: Array<{
            method: string;
            params: any;
        }> = [];
        const session = new PiThreadSession({
            cwd: process.cwd(),
            sessionFilePath: join(tmpdir(), `session-${Date.now()}-order.sqlite`),
            sessionDir: tmpdir(),
            extensionPath: "/tmp/fake-ext.mjs",
            threadId: "thr_test_order",
            providerThreadId: "fixture:1",
            scratchDir: "/tmp/pi-fixture-scratch"
        }, (method, params) => {
            notifications.push({ method, params });
            const first = Array.isArray(params.deltas) ? params.deltas[0] : undefined;
            const firstDelta = first && typeof first === "object" && "kind" in first ? first.kind : undefined;
            if (firstDelta) {
                eventOrder.push(String(firstDelta));
            }
        });
        try {
            session.runner.requestOk = async () => {
                eventOrder.push("refresh_rpc");
                return {
                    data: {
                        contextUsage: { tokens: 12500, contextWindow: 200000 },
                    },
                };
            };
            // Emit agent_start then agent_end
            await (session as any).handleRunnerEvent({ type: "agent_start" });
            await (session as any).handleRunnerEvent({
                type: "agent_end",
                messages: [
                    {
                        role: "assistant",
                        content: [{ type: "text", text: "done" }],
                        usage: { input: 12000, output: 500 },
                    },
                ],
            });
            // contextWindow must precede turn.boundary
            const cwIndex = eventOrder.indexOf("contextWindow");
            const boundaryIndex = eventOrder.indexOf("usage"); // usage/turn.boundary from agent_end
            assert.ok(cwIndex !== -1, "contextWindow delta must have been emitted");
            assert.ok(boundaryIndex !== -1, "agent_end deltas must have been emitted");
            assert.ok(cwIndex < boundaryIndex, `contextWindow (index ${cwIndex}) must be emitted before agent_end deltas (index ${boundaryIndex})`);
        }
        finally {
            session.runner.kill();
        }
    });
    it("BBEventAdapter propagates contextWindow on turn_end and run_end when resolver is provided", () => {
        const emitted: BBWireEvent[] = [];
        const contextWindowResolver = (provider?: string, modelId?: string) => {
            if (provider === "antigravity" && modelId === "gemini-3.8-flash")
                return 1048576;
            return undefined;
        };
        const adapter = new BBEventAdapter((evt) => emitted.push(evt), contextWindowResolver);
        const mockView = viewFixture({
            conversation: {
                docs: {
                    "pi.agent": {
                        model: { provider: "antigravity", modelId: "gemini-3.8-flash" },
                    },
                },
            },
        });
        adapter.handleEvent({ type: "run_start", inputs: [] as any }, mockView);
        adapter.handleEvent({ type: "turn_end" }, mockView);
        adapter.handleEvent({ type: "run_end" } as any, mockView);
        const turnEnd = emitted.find((e) => e.type === "turn_end");
        const agentEnd = emitted.find((e) => e.type === "agent_end");
        assert.ok(turnEnd);
        assert.equal((turnEnd as any).contextWindow, 1048576);
        assert.ok(agentEnd);
        assert.equal((agentEnd as any).contextWindow, 1048576);
    });
    it("DeltaTranslator maps event.contextWindow into usage deltas", () => {
        const translator = new DeltaTranslator();
        const ctx = { threadId: "thr_test_trans" };
        translator.translate(wireFixture("agent_start", { type: "agent_start" }), ctx);
        const deltas = translator.translate(wireFixture("agent_end", {
            type: "agent_end",
            contextWindow: 1048576,
            message: {
                role: "assistant",
                content: [{ type: "text", text: "done" }],
                usage: { input: 1000, output: 50 },
            },
        }), ctx);
        const usageDelta = deltas.find((d) => d.kind === "usage") as any;
        assert.ok(usageDelta);
        assert.equal(usageDelta.modelContextWindow, 1048576);
        const cwDelta = deltas.find((d) => d.kind === "contextWindow") as any;
        assert.ok(cwDelta, "contextWindow delta must be emitted synchronously on agent_end");
        assert.equal(cwDelta.used, 1050);
        assert.equal(cwDelta.size, 1048576);
        assert.equal(cwDelta.attach, "currentOrLast");
    });
});
