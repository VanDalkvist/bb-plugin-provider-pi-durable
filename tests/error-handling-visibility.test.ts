import test from "node:test";
import assert from "node:assert/strict";
import { BBEventAdapter } from "../src/runner/bridge/bb-event-adapter.ts";
import { buildFinalAssistantMessage } from "../src/runner/bridge/assistant-message-builder.ts";
import { resolveTurnSummary } from "../src/runner/bridge/turn-summary.ts";
import { translateAgentEnd } from "../src/host/message-delta-translator.ts";
import type { BBWireEvent } from "../src/runner/bridge/contracts.ts";
import type { DurableView } from "../src/runner/runtime.ts";
import type { AgentEvent } from "@earendil-works/pi-durable";

test("BBEventAdapter: message_end with error stopReason and empty content populates user-visible error text", () => {
	const emitted: BBWireEvent[] = [];
	const adapter = new BBEventAdapter((evt) => emitted.push(evt));

	const errorEvent: AgentEvent = {
		type: "message_end",
		entry: {
			model: [
				{
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "Antigravity API error (429): Rate limited by Antigravity",
				},
			],
		},
	} as unknown as AgentEvent;

	const dummyView = {
		conversation: {
			entries: [
				{
					id: 1,
					kind: "pi.assistant",
					model: [
						{
							role: "assistant",
							content: [],
							stopReason: "error",
							errorMessage: "Antigravity API error (429): Rate limited by Antigravity",
						},
					],
				},
			],
		},
	} as unknown as DurableView;

	adapter.handleEvent(errorEvent, dummyView);

	const msgEnd = emitted.find((e) => e.type === "message_end");
	assert.ok(msgEnd, "message_end event should be emitted");
	if (msgEnd.type === "message_end") {
		assert.equal(msgEnd.message.stopReason, "error");
		assert.equal(msgEnd.message.errorMessage, "Antigravity API error (429): Rate limited by Antigravity");
		assert.ok(Array.isArray(msgEnd.message.content) && msgEnd.message.content.length > 0, "content should not be empty");
		const firstBlock = msgEnd.message.content[0];
		assert.equal(firstBlock.type, "text");
		assert.match((firstBlock as { text: string }).text, /Antigravity API error \(429\)/);
	}

	// Now check run_end propagates error stopReason and errorMessage
	emitted.length = 0;
	adapter.handleEvent({ type: "run_end" } as AgentEvent, dummyView);
	const agentEnd = emitted.find((e) => e.type === "agent_end");
	assert.ok(agentEnd, "agent_end event should be emitted");
	if (agentEnd.type === "agent_end") {
		assert.equal(agentEnd.stopReason, "error");
		assert.equal(agentEnd.errorMessage, "Antigravity API error (429): Rate limited by Antigravity");
	}
});

test("buildFinalAssistantMessage: populates user-visible error text when assistant content is empty on error", () => {
	const viewWithError = {
		conversation: {
			entries: [
				{
					id: 99,
					kind: "pi.assistant",
					model: [
						{
							role: "assistant",
							content: [],
							stopReason: "error",
							errorMessage: "no response headers within 180000ms",
						},
					],
				},
			],
		},
	} as unknown as DurableView;

	const finalMsg = buildFinalAssistantMessage(viewWithError, "", "");
	assert.equal(finalMsg.stopReason, "error");
	assert.equal(finalMsg.errorMessage, "no response headers within 180000ms");
	assert.ok(finalMsg.content.length > 0, "Content must not be empty on error");
	const firstBlock = finalMsg.content[0];
	assert.equal(firstBlock.type, "text");
	assert.match((firstBlock as { text: string }).text, /no response headers within 180000ms/);
});

test("translateAgentEnd: emits turn.boundary with status 'failed' and error payload when turn errored", () => {
	const agentEndEvent = {
		type: "agent_end",
		stopReason: "error",
		errorMessage: "Model unavailable: Resource has been exhausted",
		messages: [
			{
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: "Model unavailable: Resource has been exhausted",
			},
		],
	};

	const result = translateAgentEnd(agentEndEvent, "", false);
	const turnBoundary = result.deltas.find((d) => d.kind === "turn.boundary");
	assert.ok(turnBoundary, "turn.boundary must be emitted");
	assert.equal(turnBoundary.status, "failed");
	assert.deepEqual(turnBoundary.error, {
		message: "Model unavailable: Resource has been exhausted",
	});

	// If currentAgentText was empty, it should close the text channel with the error text
	const textClose = result.deltas.find((d) => d.kind === "item.textClose");
	assert.ok(textClose, "item.textClose must be emitted to show error in transcript");
	assert.match(String(textClose.text), /Model unavailable: Resource has been exhausted/);
});
