import test from "node:test";
import assert from "node:assert/strict";
import { BBEventAdapter } from "../src/runner/bridge/bb-event-adapter.ts";
import { DeltaTranslator } from "../src/host/delta-translator.ts";
import type { DurableView } from "../src/runner/runtime-types.ts";
import type { BBWireEvent } from "../src/runner/bridge/contracts.ts";
import { viewFixture } from "./fixtures/durable.ts";
import { publicDeltaFixture, wireFixture } from "./fixtures/wire.ts";

test("BBEventAdapter streams initial text from text_start and initial thinking from thinking_start", () => {
    const emitted: BBWireEvent[] = [];
    const adapter = new BBEventAdapter((evt) => emitted.push(evt));
    const dummyView = viewFixture({});
    adapter.handleEvent({ type: "run_start", inputs: [] as any }, dummyView);
    adapter.handleEvent({ type: "turn_start" }, dummyView);
    // Initial thinking from thinking_start
    adapter.handleEvent({
        type: "message_update",
        changes: [
            {
                type: "thinking_start",
                contentIndex: 0,
                block: { type: "thinking", thinking: "Initial thought." },
            },
            {
                type: "thinking_delta",
                contentIndex: 0,
                delta: " More thought.",
            },
        ],
    } as any, dummyView);
    const thinkingDeltas = emitted
        .filter((e) => e.type === "message_update" && (e as any).assistantMessageEvent?.type === "thinking_delta")
        .map((e) => (e as any).assistantMessageEvent.delta);
    assert.deepEqual(thinkingDeltas, ["Initial thought.", " More thought."]);
    // Initial text from text_start (e.g. after tool execution resumed by Chord)
    adapter.handleEvent({
        type: "message_update",
        changes: [
            {
                type: "text_start",
                contentIndex: 1,
                block: { type: "text", text: "Initial text after tool." },
            },
            {
                type: "text_delta",
                contentIndex: 1,
                delta: " Followup text.",
            },
        ],
    } as any, dummyView);
    const textDeltas = emitted
        .filter((e) => e.type === "message_update" && (e as any).assistantMessageEvent?.type === "text_delta")
        .map((e) => (e as any).assistantMessageEvent.delta);
    assert.deepEqual(textDeltas, ["Initial text after tool.", " Followup text."]);
});
