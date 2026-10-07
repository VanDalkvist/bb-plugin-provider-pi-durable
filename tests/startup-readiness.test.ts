import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PiThreadSession } from "../src/host/session.ts";

describe("Startup Readiness & Fail-Fast Handshake (Issue #3)", () => {
	it("PiThreadSession.start() rejects immediately when runner exits before becoming ready", async () => {
		const session = new PiThreadSession(
			{
				cwd: process.cwd(),
				sessionFilePath: "/tmp/fake-session.sqlite",
				sessionDir: "/tmp",
				extensionPath: "/tmp/fake-ext.mjs",
				threadId: "thr_test_exit",
			},
			() => {},
		);

		// Simulate child exiting immediately before ready
		(session.runner as any).options.onExit?.(1, null);

		await assert.rejects(
			async () => session.start(),
			(err: Error) => {
				assert.ok(err.message.includes("Runner exited before becoming ready") || err.message.includes("timed out"));
				return true;
			},
		);
		session.runner.kill();
	});

	it("PiThreadSession.start() rejects when initial context refresh RPC fails", async () => {
		const session = new PiThreadSession(
			{
				cwd: process.cwd(),
				sessionFilePath: "/tmp/fake-session.sqlite",
				sessionDir: "/tmp",
				extensionPath: "/tmp/fake-ext.mjs",
				threadId: "thr_test_rpc",
			},
			() => {},
		);

		// Deliver ready
		(session.runner as any).options.onChannelMessage?.({ kind: "ready" });

		// Stub request to fail on get_state
		session.runner.request = async () => {
			throw new Error("RPC get_state connection reset (injected)");
		};

		await assert.rejects(
			async () => session.start(),
			(err: Error) => {
				assert.ok(err.message.includes("RPC get_state connection reset"));
				return true;
			},
		);
		session.runner.kill();
	});

	it("PiThreadSession.start() clears timeout timer upon successful ready", async () => {
		let clearedTimer: any = null;
		const originalClearTimeout = globalThis.clearTimeout;
		globalThis.clearTimeout = ((t: any) => {
			clearedTimer = t;
			originalClearTimeout(t);
		}) as any;

		const session = new PiThreadSession(
			{
				cwd: process.cwd(),
				sessionFilePath: "/tmp/fake-session.sqlite",
				sessionDir: "/tmp",
				extensionPath: "/tmp/fake-ext.mjs",
				threadId: "thr_test_timer",
			},
			() => {},
		);

		// Deliver ready
		(session.runner as any).options.onChannelMessage?.({ kind: "ready" });
		session.runner.request = async () => ({
			contextUsage: { tokens: 100, contextWindow: 200000 },
		});

		try {
			await session.start();
			assert.ok(clearedTimer !== null, "timeout timer must be explicitly cleared on success");
		} finally {
			globalThis.clearTimeout = originalClearTimeout;
			session.runner.kill();
		}
	});

	it("Runner announces ready in catalogue probe mode (--no-session)", async () => {
		const session = new PiThreadSession(
			{
				cwd: process.cwd(),
				sessionFilePath: "/tmp/fake-session.sqlite",
				sessionDir: "/tmp",
				extensionPath: "/tmp/fake-ext.mjs",
				threadId: "thr_test_cat",
				noSession: true,
			},
			() => {},
		);

		let receivedReady = false;
		session.readyPromise.then(() => {
			receivedReady = true;
		});

		try {
			// Runner in --no-session will execute models discovery and emit ready over FD 3
			await Promise.race([
				session.readyPromise,
				new Promise((_, reject) => setTimeout(() => reject(new Error("Catalogue ready timed out")), 5000)),
			]);
			assert.equal(receivedReady, true, "Catalogue mode must become ready without opening SQLite session");
		} finally {
			session.runner.kill();
		}
	});
});
