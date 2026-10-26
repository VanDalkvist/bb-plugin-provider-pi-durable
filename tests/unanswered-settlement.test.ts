import test from "node:test";
import assert from "node:assert/strict";
import { BBEventAdapter } from "../src/runner/bridge/bb-event-adapter.ts";
import { translateAgentEnd } from "../src/host/message-delta-translator.ts";
import type { DurableView } from "../src/runner/runtime-types.ts";
import { entryFixture, nativeAssistantFixture, viewFixture } from "./fixtures/durable.ts";

test("Issue #23 reproduction: unanswered input submission with toolUse progress must produce failed turn boundary", () => {
    const outputEvents: any[] = [];
    const adapter = new BBEventAdapter((evt) => outputEvents.push(evt), () => 128000);
    const currentView: DurableView = viewFixture({
        conversation: {
            entries: [
                entryFixture({
                    id: 1,
                    kind: "pi.user",
                    model: [{ role: "user", content: "Do something risky", timestamp: 1 }],
                }),
                entryFixture({
                    id: 2,
                    kind: "pi.assistant",
                    model: [
                        nativeAssistantFixture({
                            role: "assistant",
                            content: [{ type: "text", text: "Working on the request..." }],
                            stopReason: "toolUse",
                        })
                    ],
                })
            ],
        },
    });
    const batch: any[] = [
        { type: "task_failed", taskId: 20, kind: "pi.generation", message: "synthetic fault" },
        { type: "turn_end" },
        { type: "run_end", inputs: [11] },
        {
            type: "submission",
            record: {
                id: 11,
                conversationId: 1,
                type: "input",
                entry: 1,
                status: "unanswered",
                reason: "faulted",
                detail: "synthetic fault",
            },
        },
    ];
    adapter.handleBatch(batch, currentView);
    const agentEnd = outputEvents.find((e) => e.type === "agent_end");
    assert.ok(agentEnd, "Must emit agent_end event on run_end");
    assert.equal(agentEnd.stopReason, "error");
    assert.equal(agentEnd.errorMessage, "synthetic fault");
    const { deltas } = translateAgentEnd(agentEnd, "Working on the request...", false);
    const boundary = deltas.find((d) => d.kind === "turn.boundary") as any;
    assert.ok(boundary, "Must emit turn.boundary");
    assert.equal(boundary.status, "failed");
    assert.ok(boundary.error?.message?.includes("synthetic fault"));
    const textClose = deltas.find((d) => d.kind === "item.textClose") as any;
    assert.ok(textClose, "Must close agent text progress");
    assert.equal(textClose.text, "Working on the request...");
});

test("Regression check: done submission with toolUse must complete normally", () => {
    const outputEvents: any[] = [];
    const adapter = new BBEventAdapter((evt) => outputEvents.push(evt), () => 128000);
    const currentView: DurableView = viewFixture({
        conversation: {
            entries: [
                entryFixture({
                    id: 1,
                    kind: "pi.user",
                    model: [{ role: "user", content: "Legitimate tool use handoff", timestamp: 1 }],
                }),
                entryFixture({
                    id: 2,
                    kind: "pi.assistant",
                    model: [
                        nativeAssistantFixture({
                            role: "assistant",
                            content: [{ type: "text", text: "Finished with tool" }],
                            stopReason: "toolUse",
                        })
                    ],
                })
            ],
        },
    });
    const batch: any[] = [
        { type: "turn_end" },
        { type: "run_end", inputs: [12] },
        {
            type: "submission",
            record: {
                id: 12,
                conversationId: 1,
                type: "input",
                entry: 1,
                status: "done",
            },
        },
    ];
    adapter.handleBatch(batch, currentView);
    const agentEnd = outputEvents.find((e) => e.type === "agent_end");
    assert.ok(agentEnd);
    assert.equal(agentEnd.stopReason, undefined);
    const { deltas } = translateAgentEnd(agentEnd, "Finished with tool", false);
    const boundary = deltas.find((d) => d.kind === "turn.boundary") as any;
    assert.ok(boundary);
    assert.equal(boundary.status, "completed");
});

test("Regression check: unanswered with reason aborted must produce interrupted status", () => {
    const outputEvents: any[] = [];
    const adapter = new BBEventAdapter((evt) => outputEvents.push(evt), () => 128000);
    const currentView: DurableView = viewFixture({
        conversation: {
            entries: [
                entryFixture({
                    id: 1,
                    kind: "pi.user",
                    model: [{ role: "user", content: "Stop this", timestamp: 1 }],
                })
            ],
        },
    });
    const batch: any[] = [
        { type: "turn_end" },
        { type: "run_end", inputs: [13] },
        {
            type: "submission",
            record: {
                id: 13,
                conversationId: 1,
                type: "input",
                entry: 1,
                status: "unanswered",
                reason: "aborted",
            },
        },
    ];
    adapter.handleBatch(batch, currentView);
    const agentEnd = outputEvents.find((e) => e.type === "agent_end");
    assert.ok(agentEnd);
    assert.equal(agentEnd.aborted, true);
    assert.equal(agentEnd.stopReason, "aborted");
    const { deltas } = translateAgentEnd(agentEnd, "Interrupted work", false);
    const boundary = deltas.find((d) => d.kind === "turn.boundary") as any;
    assert.ok(boundary);
    assert.equal(boundary.status, "interrupted");
});
