import test from "node:test";
import assert from "node:assert/strict";
import { BBEventAdapter } from "../src/runner/bridge/bb-event-adapter.ts";
import { translateAgentEnd } from "../src/host/message-delta-translator.ts";
import type { DurableView } from "../src/runner/runtime-types.ts";
import { entryFixture, nativeAssistantFixture, viewFixture } from "./fixtures/durable.ts";

test("Regression check: delayed old settlement does not contaminate newer input", () => {
    const outputEvents: any[] = [];
    const adapter = new BBEventAdapter((evt) => outputEvents.push(evt), () => 128000);
    // Pre-record an old aborted submission for input 5
    adapter.handleEvent({
        type: "submission",
        record: {
            id: 5,
            conversationId: 1,
            type: "input",
            entry: 1,
            status: "unanswered",
            reason: "faulted",
        },
    } as any, {} as any);
    const currentView: DurableView = viewFixture({
        conversation: {
            entries: [
                entryFixture({
                    id: 10,
                    kind: "pi.assistant",
                    model: [
                        nativeAssistantFixture({
                            role: "assistant",
                            content: [{ type: "text", text: "Healthy turn" }],
                            stopReason: "stop",
                        })
                    ],
                })
            ],
        },
    });
    // Now run_end occurs for input 6 (not input 5)
    const batch: any[] = [
        { type: "run_end", inputs: [6] },
        {
            type: "submission",
            record: {
                id: 6,
                conversationId: 1,
                type: "input",
                entry: 10,
                status: "done",
            },
        },
    ];
    adapter.handleBatch(batch, currentView);
    const agentEnd = outputEvents.find((e) => e.type === "agent_end");
    assert.ok(agentEnd);
    assert.notEqual(agentEnd.stopReason, "error");
    const { deltas } = translateAgentEnd(agentEnd, "Healthy turn", false);
    const boundary = deltas.find((d) => d.kind === "turn.boundary") as any;
    assert.equal(boundary.status, "completed");
});
