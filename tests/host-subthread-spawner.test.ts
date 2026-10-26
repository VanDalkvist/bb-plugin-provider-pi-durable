import test from "node:test";
import assert from "node:assert/strict";
import { buildSpawnArgs, spawnSubthreadInBb } from "../src/host/subthread-spawner.ts";

test("buildSpawnArgs includes required project, parent-thread, provider, and title", () => {
	const origEnv = process.env.BB_ENVIRONMENT_ID;
	delete process.env.BB_ENVIRONMENT_ID;
	try {
		const args = buildSpawnArgs({
			projectId: "proj_personal",
			parentThreadId: "thr_parent_123",
			title: "Subagent: Fix security leak",
			task: "Fix security leak in auth controller",
		});

		assert.deepEqual(args, [
			"thread",
			"spawn",
			"--project",
			"proj_personal",
			"--parent-thread",
			"thr_parent_123",
			"--title",
			"Subagent: Fix security leak",
			"--prompt",
			"Fix security leak in auth controller",
			"--provider",
			"pi-durable",
			"--json",
		]);
	} finally {
		if (origEnv !== undefined) process.env.BB_ENVIRONMENT_ID = origEnv;
	}
});

test("buildSpawnArgs appends --environment when environmentId is explicitly passed or in env", () => {
	const argsExplicit = buildSpawnArgs({
		projectId: "proj_personal",
		environmentId: "env_explicit_777",
		parentThreadId: "thr_parent_123",
		title: "Subagent: Fix",
		task: "Fix",
	});

	assert.ok(argsExplicit.includes("--environment"));
	assert.equal(argsExplicit[argsExplicit.indexOf("--environment") + 1], "env_explicit_777");

	const origEnv = process.env.BB_ENVIRONMENT_ID;
	process.env.BB_ENVIRONMENT_ID = "env_ambient_888";
	try {
		const argsAmbient = buildSpawnArgs({
			projectId: "proj_personal",
			parentThreadId: "thr_parent_123",
			title: "Subagent: Fix",
			task: "Fix",
		});
		assert.ok(argsAmbient.includes("--environment"));
		assert.equal(argsAmbient[argsAmbient.indexOf("--environment") + 1], "env_ambient_888");
	} finally {
		if (origEnv !== undefined) {
			process.env.BB_ENVIRONMENT_ID = origEnv;
		} else {
			delete process.env.BB_ENVIRONMENT_ID;
		}
	}
});

test("spawnSubthreadInBb registers thread when CLI returns thread JSON", async () => {
    let registered: {
        threadId: string;
        conversationId: string;
    } | undefined;
    const mockSession = {
        registerThread: (threadId: string, conversationId?: string) => {
            if (conversationId)
                registered = { threadId, conversationId };
            return false;
        },
    };
    // Mock spawner function injecting simulated JSON output
    await spawnSubthreadInBb({
        projectId: "proj_personal",
        parentThreadId: "thr_parent_123",
        title: "Subagent: Audit",
        task: "Audit",
        conversationId: "2",
    }, mockSession, {
        execCommand: async () => JSON.stringify({ id: "thr_child_456", ok: true }),
    });
    assert.deepEqual(registered, {
        threadId: "thr_child_456",
        conversationId: "2",
    });
});
