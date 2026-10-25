import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { translateMessageUpdate, translateMessageEnd } from "../src/host/message-delta-translator.ts";

test("reasoning channels preserve parent, hide policy and close before visible text", () => {
	const state = { currentThinkingIndex: 0, currentAgentText: "", openThinkingChannels: new Set<string>() };
	const start = translateMessageUpdate({ type: "thinking_start", contentIndex: 2 }, state, { hideThinking: true }, "call-a");
	assert.deepEqual(start[0].key, { channel: "call-a:thinking-2", parentRef: "call-a" });
	assert.deepEqual(start[0].presentation, { label: { pending: "Thinking", completed: "Thought" }, icon: { glyph: "Brain" }, suppress: true });
	const text = translateMessageUpdate({ type: "text_delta", contentIndex: 0, delta: "done" }, state, {}, "call-a");
	assert.deepEqual(text.map((d) => d.kind), ["item.textClose", "item.textDelta"]);
	assert.equal(state.openThinkingChannels.size, 0);
	assert.equal(text[1].text, "done");
	assert.deepEqual(text[1].key, { channel: "call-a:agentMessage", parentRef: "call-a" });
});

test("terminal message closes all remaining reasoning channels without losing final text", () => {
	const channels = new Set(["thinking-1"]);
	const result = translateMessageEnd({ content: [{ type: "text", text: "final" }] }, "delta", channels);
	assert.equal(result.deltas[0].channel, "reasoningText");
	assert.equal(result.deltas[1].text, "final");
	assert.equal(channels.size, 0);
	assert.equal(result.nextAgentText, "");
});

test("general message translator stays below the project strict line budget", () => {
	const content = readFileSync(new URL("../src/host/message-delta-translator.ts", import.meta.url), "utf8");
	assert.ok((content.match(/\n/g) ?? []).length < 200, "message and reasoning responsibilities need separate owners");
});
