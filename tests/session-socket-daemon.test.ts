import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { SessionDaemon } from "../src/runner/session-daemon.ts";

test("SessionDaemon: Master creates unix socket and client communicates over IPC (BL-DZ-01)", async () => {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-daemon-test-"));
	const daemon = new SessionDaemon(tmpDir);

	try {
		// Before start, tryConnectClient must return null
		const clientBefore = await daemon.tryConnectClient(100);
		assert.equal(clientBefore, null, "Expected no client connection before master starts");

		// Start master daemon
		const masterStarted = await daemon.startMaster((socket) => {
			socket.on("data", (chunk) => {
				const line = chunk.toString("utf8").trim();
				if (line === "PING") {
					socket.write("PONG\n");
				}
			});
		});
		assert.equal(masterStarted, true, "Master should start successfully");

		// Connect client
		const client = await daemon.tryConnectClient(500);
		assert.ok(client, "Expected client connection to succeed");

		// Send PING and receive PONG
		const pongPromise = new Promise<string>((resolve) => {
			client!.on("data", (data) => {
				resolve(data.toString("utf8").trim());
			});
		});

		client!.write("PING\n");
		const response = await pongPromise;
		assert.equal(response, "PONG");

		client!.end();
	} finally {
		await daemon.close();
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
});

test("SessionDaemon: cleans up stale orphan socket file when previous master crashed", async () => {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-daemon-stale-"));
	const socketPath = path.join(tmpDir, "runner.sock");

	// Simulate stale socket file left behind by SIGKILL
	await fs.writeFile(socketPath, "stale");

	const daemon = new SessionDaemon(tmpDir);
	try {
		// tryConnectClient should detect dead socket, clean it up, and return null
		const client = await daemon.tryConnectClient(100);
		assert.equal(client, null, "Should return null for dead socket file");

		// Verify that stale socket was unlinked
		const exists = await fs.stat(socketPath).then(() => true).catch(() => false);
		assert.equal(exists, false, "Stale socket should be removed");

		// Master should now start cleanly on the cleaned path
		const masterStarted = await daemon.startMaster(() => {});
		assert.equal(masterStarted, true, "Master should start cleanly after stale socket removal");
	} finally {
		await daemon.close();
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
});
