import test from "node:test";
import assert from "node:assert/strict";
import { buildSpawnArgs, spawnSubthreadInBb } from "../src/host/subthread-spawner.ts";

test("buildSpawnArgs respects explicit projectId", () => {
	const origEnv = process.env.BB_ENVIRONMENT_ID;
	delete process.env.BB_ENVIRONMENT_ID;
	try {
		const args = buildSpawnArgs({
			projectId: "proj_custom_123",
			parentThreadId: "thr_parent_1",
			title: "Background worker",
			task: "Refactor auth controller",
			conversationId: "conv_77",
		});

		assert.deepEqual(args, [
			"thread",
			"spawn",
			"--project",
			"proj_custom_123",
			"--parent-thread",
			"thr_parent_1",
			"--title",
			"Background worker",
			"--prompt",
			"Refactor auth controller",
			"--provider",
			"pi-durable",
			"--json",
		]);
	} finally {
		if (origEnv !== undefined) process.env.BB_ENVIRONMENT_ID = origEnv;
	}
});

test("spawnSubthreadInBb executes command and links registered thread", async () => {
	let registeredThread: { threadId: string; conversationId?: string } | undefined;
	const mockSession = {
		registerThread: (threadId: string, conversationId?: string) => {
			registeredThread = { threadId, conversationId };
		},
	};

	const threadId = await spawnSubthreadInBb(
		{
			projectId: "proj_personal",
			parentThreadId: "thr_parent_1",
			title: "Background task",
			task: "Compute prime numbers",
			conversationId: "conv_88",
		},
		mockSession,
		{
			execCommand: async () => JSON.stringify({ id: "thr_child_88", ok: true }),
		},
	);

	assert.equal(threadId, "thr_child_88");
	assert.deepEqual(registeredThread, {
		threadId: "thr_child_88",
		conversationId: "conv_88",
	});
});
