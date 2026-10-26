import test from "node:test";
import assert from "node:assert/strict";
import { DeltaTranslator } from "../src/host/delta-translator.ts";
import {
	translateMessageUpdate,
	REASONING_PRESENTATION,
} from "../src/host/message-delta-translator.ts";
import plugin from "../server.ts";
import { wireFixture } from "./fixtures/wire.ts";

test("DeltaTranslator: fallback closure closes unclosed thinking channel when text_delta arrives", () => {
    const translator = new DeltaTranslator();
    // Emit thinking_delta without explicit thinking_end
    translator.translate(wireFixture("message_update", {
        type: "message_update",
        assistantMessageEvent: {
            type: "thinking_delta",
            contentIndex: 0,
            delta: "Open thinking chunk",
        },
    }), { threadId: "thr-1" });
    // Now text_delta arrives directly
    const deltas = translator.translate(wireFixture("message_update", {
        type: "message_update",
        assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "Direct answer",
        },
    }), { threadId: "thr-1" });
    assert.equal(deltas.length, 2);
    assert.deepEqual(deltas[0], {
        kind: "item.textClose",
        key: { channel: "thinking-0" },
        channel: "reasoningText",
        text: "",
    });
    assert.deepEqual(deltas[1], {
        kind: "item.textDelta",
        key: { channel: "agentMessage" },
        channel: "agentMessage",
        text: "Direct answer",
    });
});

test("DeltaTranslator: fallback closure closes unclosed thinking channel when message_end arrives", () => {
    const translator = new DeltaTranslator();
    translator.translate(wireFixture("message_update", {
        type: "message_update",
        assistantMessageEvent: {
            type: "thinking_delta",
            contentIndex: 0,
            delta: "Open thinking chunk",
        },
    }), { threadId: "thr-1" });
    const deltas = translator.translate(wireFixture("message_end", {
        type: "message_end",
        message: {
            role: "assistant",
            content: [{ type: "text", text: "Answer from message_end" }],
        },
    }), { threadId: "thr-1" });
    assert.equal(deltas.length, 2);
    assert.deepEqual(deltas[0], {
        kind: "item.textClose",
        key: { channel: "thinking-0" },
        channel: "reasoningText",
        text: "",
    });
    assert.deepEqual(deltas[1], {
        kind: "item.textClose",
        key: { channel: "agentMessage" },
        channel: "agentMessage",
        text: "Answer from message_end",
    });
});
