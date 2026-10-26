import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RunnerProcess } from "../src/host/runner-process.ts";
import { PiThreadSession } from "../src/host/session.ts";
import { DeltaTranslator } from "../src/host/delta-translator.ts";
import { BBEventAdapter } from "../src/runner/bridge/bb-event-adapter.ts";
import type { DurableView } from "../src/runner/runtime-types.ts";
import type { BBWireEvent } from "../src/runner/bridge/contracts.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { viewFixture } from "./fixtures/durable.ts";
import { wireFixture } from "./fixtures/wire.ts";

describe("Context Window Telemetry & Usage Synchronization (Cycle 57)", () => {
    it("RunnerProcess.requestOk unwraps data payload and rejects on success: false", async () => {
        const runner = new RunnerProcess({
            cwd: process.cwd(),
            args: ["--mode", "rpc", "--no-session"],
        });
        try {
            // Mock incoming message with data payload
            (runner as any).handleIncoming({
                id: "req_test_1",
                type: "response",
                command: "get_session_stats",
                success: true,
                data: {
                    contextUsage: { tokens: 45000, contextWindow: 1048576 },
                },
            });
            // If request resolves via handleIncoming
            const mockPending = (runner as any).pendingRequests;
            mockPending.set("req_100", {
                command: "get_session_stats",
                resolve: (val: any) => val,
                reject: (err: any) => { throw err; },
            });
            (runner as any).handleIncoming({
                id: "req_100",
                type: "response",
                command: "get_session_stats",
                success: true,
                data: {
                    contextUsage: { tokens: 42000, contextWindow: 1048576 },
                },
            });
            // Direct verification of requestOk unwrapping behavior
            (runner as any).request = async () => ({
                id: "req_200",
                type: "response",
                command: "get_session_stats",
                success: true,
                data: {
                    contextUsage: { tokens: 42000, contextWindow: 1048576 },
                },
            });
            const unwrapped = await runner.requestOk({ type: "get_session_stats" });
            assert.deepEqual(unwrapped, {
                contextUsage: { tokens: 42000, contextWindow: 1048576 },
            });
            // Verification that success: false rejects
            (runner as any).request = async () => ({
                id: "req_201",
                type: "response",
                command: "test_fail",
                success: false,
                error: "Failed to estimate tokens",
            });
            await assert.rejects(async () => runner.requestOk({ type: "test_fail" }), (err: Error) => {
                assert.equal(err.message, "Failed to estimate tokens");
                return true;
            });
        }
        finally {
            runner.kill();
        }
    });
    it("PiThreadSession.getSessionStats extracts contextUsage from wrapped or unwrapped responses", async () => {
        const session = new PiThreadSession({
            cwd: process.cwd(),
            sessionFilePath: join(tmpdir(), `session-${Date.now()}-stats.sqlite`),
            sessionDir: tmpdir(),
            extensionPath: "/tmp/fake-ext.mjs",
            threadId: "thr_test_stats",
            providerThreadId: "fixture:1",
            scratchDir: "/tmp/pi-fixture-scratch"
        }, () => { });
        try {
            // Case 1: Wrapped inside data (actual wire format)
            session.runner.requestOk = async () => ({
                data: {
                    contextUsage: { tokens: 35000, contextWindow: 1048576 },
                },
            });
            const stats1 = await session.getSessionStats();
            assert.equal(stats1.tokens, 35000);
            assert.equal(stats1.contextWindow, 1048576);
            // Case 2: Unwrapped contextUsage top-level
            session.runner.requestOk = async () => ({
                contextUsage: { tokens: 45300, contextWindow: 1048576 },
            });
            const stats2 = await session.getSessionStats();
            assert.equal(stats2.tokens, 45300);
            assert.equal(stats2.contextWindow, 1048576);
            // Case 3: Empty / missing returns safe fallback
            session.runner.requestOk = async () => ({});
            const stats3 = await session.getSessionStats();
            assert.equal(stats3.tokens, null);
            assert.equal(stats3.contextWindow, 0);
        }
        finally {
            session.runner.kill();
        }
    });
    it("PiThreadSession.refreshContextUsage sends contextWindow delta with correct tokens and size", async () => {
        const notifications: Array<{
            method: string;
            params: any;
        }> = [];
        const session = new PiThreadSession({
            cwd: process.cwd(),
            sessionFilePath: join(tmpdir(), `session-${Date.now()}-refresh.sqlite`),
            sessionDir: tmpdir(),
            extensionPath: "/tmp/fake-ext.mjs",
            threadId: "thr_test_refresh",
            providerThreadId: "fixture:1",
            scratchDir: "/tmp/pi-fixture-scratch"
        }, (method, params) => notifications.push({ method, params }));
        try {
            session.runner.requestOk = async () => ({
                data: {
                    contextUsage: { tokens: 45300, contextWindow: 1048576 },
                },
            });
            await session.refreshContextUsage();
            assert.equal(notifications.length, 1);
            assert.equal(notifications[0].method, "thread/delta");
            assert.equal(notifications[0].params.threadId, "thr_test_refresh");
            assert.deepEqual(notifications[0].params.deltas, [
                {
                    kind: "contextWindow",
                    used: 45300,
                    size: 1048576,
                    estimated: true,
                    attach: "currentOrLast",
                },
            ]);
        }
        finally {
            session.runner.kill();
        }
    });
});
