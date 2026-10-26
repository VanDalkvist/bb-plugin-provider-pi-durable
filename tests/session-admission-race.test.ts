import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionRegistry } from "../src/host/session-registry.ts";
import { ProviderBridge } from "../src/host/bridge.ts";
import { sessionFixture } from "./fixtures/mirror.ts";

test("GREEN (P1 Repro): concurrent thread/start and turn/start on same session should succeed with single session and no lock crash", async (t) => {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-concur-test-"));
	const oldSessionDir = process.env.BB_PI_BRIDGE_SESSION_DIR;
	process.env.BB_PI_BRIDGE_SESSION_DIR = tempDir;

	t.after(() => {
		if (oldSessionDir !== undefined) {
			process.env.BB_PI_BRIDGE_SESSION_DIR = oldSessionDir;
		} else {
			delete process.env.BB_PI_BRIDGE_SESSION_DIR;
		}
		try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
	});

	const sent: string[] = [];
	const bridge = new ProviderBridge((json) => {
		sent.push(json);
	});

	const threadId = "thr_concur_red_1";
	const providerThreadId = `pi_durable_concur_red_${Date.now()}`;

	// Send thread/start and turn/start concurrently (exact finding reproduction)
	await Promise.all([
		bridge.handleLine(JSON.stringify({
			jsonrpc: "2.0",
			id: 2,
			method: "thread/start",
			params: {
				threadId,
				providerThreadId,
				cwd: tempDir,
			},
		})),
		bridge.handleLine(JSON.stringify({
			jsonrpc: "2.0",
			id: 3,
			method: "turn/start",
			params: {
				threadId,
				providerThreadId,
				clientRequestId: "req_concur_1",
				input: [{ type: "text", text: "Hello from concurrent turn" }],
				cwd: tempDir,
			},
		})),
	]);

	await bridge.shutdown();

	const responses = sent.map((s) => JSON.parse(s));
	const startResponse = responses.find((r) => r.id === 2);
	const turnResponse = responses.find((r) => r.id === 3);

	assert.ok(startResponse, "thread/start response must be received");
	assert.ok(turnResponse, "turn/start response must be received");

	assert.equal(startResponse.error, undefined, `thread/start failed: ${JSON.stringify(startResponse.error)}`);
	assert.equal(startResponse.result.providerThreadId, providerThreadId);
	assert.equal(turnResponse.error, undefined, `turn/start failed: ${JSON.stringify(turnResponse.error)}`);
	assert.equal(turnResponse.result.threadId, threadId);
});

test("SessionRegistry: concurrent createOrGet on same threadId coalesces into 1 creation and waiters get same session", async () => {
	let factoryCalls = 0;
	let startCalls = 0;
	const mockSession = sessionFixture({
		options: { threadId: "thr_concur", providerThreadId: "pi_durable_1" },
		start: async () => {
			startCalls++;
			await new Promise((r) => setTimeout(r, 20));
		},
	});

	const registry = new SessionRegistry(
		() => {},
		() => {
			factoryCalls++;
			return mockSession;
		},
	);

	const results = await Promise.all([
		registry.createOrGet("thr_concur", "pi_durable_1"),
		registry.createOrGet("thr_concur", "pi_durable_1"),
		registry.createOrGet("thr_concur", "pi_durable_1"),
	]);

	assert.equal(factoryCalls, 1, "Factory must only be called once");
	assert.equal(startCalls, 1, "start() must only be called once");
	assert.equal(results[0], mockSession);
	assert.equal(results[1], mockSession);
	assert.equal(results[2], mockSession);
});

test("SessionRegistry: concurrent root and child createOrGet on same sessionKey coalesces into 1 session and binds child conversation", async () => {
	let factoryCalls = 0;
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	const boundThreads: Array<{ threadId: string; conversationId?: string }> = [];

	const mockSession = sessionFixture({
		options: { threadId: "thr_parent", providerThreadId: "pi_shared_1" },
		registerThread: (threadId: string, conversationId?: string) => {
			boundThreads.push({ threadId, conversationId });
			return false;
		},
		start: async () => {
			await new Promise((r) => setTimeout(r, 20));
		},
	});

	const registry = new SessionRegistry(
		(method, params) => notifications.push({ method, params }),
		() => {
			factoryCalls++;
			return mockSession;
		},
	);

	const [parentRes, childRes] = await Promise.all([
		registry.createOrGet("thr_parent", "pi_shared_1"),
		registry.createOrGet("thr_child", "pi_shared_1:2", { parentThreadId: "thr_parent" }),
	]);

	assert.equal(factoryCalls, 1, "Only one underlying session must be created");
	assert.equal(parentRes, mockSession);
	assert.equal(childRes, mockSession);
	assert.equal(registry.get("thr_parent"), mockSession);
	assert.equal(registry.get("thr_child"), mockSession);

	const childIdentity = notifications.find((n) => n.method === "thread/identity" && n.params.threadId === "thr_child");
	assert.ok(childIdentity, "Child thread identity notification must be emitted");
	assert.equal(childIdentity.params.providerThreadId, "pi_shared_1:2");

	const childReset = notifications.find((n) => n.method === "thread/delta" && n.params.threadId === "thr_child");
	assert.ok(childReset, "Child thread reset delta must be emitted");
});
