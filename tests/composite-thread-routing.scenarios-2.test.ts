import type { PromptRequest } from "../src/host/prompt-request.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { parseProviderThreadId, formatProviderThreadId } from "../src/host/composite-id.ts";
import { SessionRegistry } from "../src/host/session-registry.ts";
import type { PiThreadSession } from "../src/host/session.ts";
import { sessionFixture } from "./fixtures/mirror.ts";

test("handleActiveSessionCommand targets child conversation when conversationId is provided", async () => {
	const { handleActiveSessionCommand } = await import("../src/runner/session-commands.ts");

	let submitCalledWith: unknown;
	let abortCalled = false;
	const mockChildConv = {
		submit: async (req: unknown) => {
			submitCalledWith = req;
		},
		abort: async () => {
			abortCalled = true;
		},
	};

	let requestedConvId: string | undefined;
	const mockDurable = {
		harness: {
			conversation: async (convId: string) => {
				requestedConvId = convId;
				return mockChildConv;
			},
		},
		controller: {
			submit: async () => {
				assert.fail("root controller submit should not be called when conversationId is present");
			},
			abort: async () => {
				assert.fail("root controller abort should not be called when conversationId is present");
			},
		},
	};

	const successes: Array<{ command: string }> = [];
	const responder = {
		success: (_id: unknown, command: string) => successes.push({ command }),
		error: (_id: unknown, _cmd: unknown, msg: string) => {
			throw new Error(`Unexpected error: ${msg}`);
		},
	};

	// 1. Prompt on child
	await handleActiveSessionCommand(
		{ type: "prompt", message: "child prompt", conversationId: "99" },
		mockDurable as any,
		{} as any,
		{} as any,
		responder,
	);
	assert.equal(requestedConvId, 99);
	assert.deepEqual(submitCalledWith, { type: "input", content: "child prompt", whenBusy: "followUp" });

	// 2. Steer on child
	await handleActiveSessionCommand(
		{ type: "steer", message: "child steer", conversationId: "99" },
		mockDurable as any,
		{} as any,
		{} as any,
		responder,
	);
	assert.deepEqual(submitCalledWith, { type: "input", content: "child steer", whenBusy: "steer" });

	// 3. Abort on child
	await handleActiveSessionCommand(
		{ type: "abort", conversationId: "99" },
		mockDurable as any,
		{} as any,
		{} as any,
		responder,
	);
	assert.equal(abortCalled, true);
});
