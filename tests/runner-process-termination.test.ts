import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it, mock } from "node:test";
import { RunnerProcess } from "../src/host/runner-process.ts";

class MockChild extends EventEmitter {
	closeInputCalls = 0;
	killCalls = 0;
	stdin = {
		end: () => { this.closeInputCalls++; },
		write: (data: string) => {
			const message: unknown = JSON.parse(data);
			if (typeof message !== "object" || message === null || !("id" in message) || typeof message.id !== "string") {
				throw new Error("RunnerProcess wrote an invalid request");
			}
			queueMicrotask(() => runner?.handleIncoming({ type: "response", id: message.id, success: true }));
			return true;
		},
	};
	stdout = null;
	stderr = null;
	stdio: Array<NodeJS.ReadableStream | NodeJS.WritableStream | null> = [null, null, null, null, null];

	kill(): boolean {
		this.killCalls++;
		return true;
	}
}

let runner: RunnerProcess | undefined;

function createRunner(child: MockChild): RunnerProcess {
	runner = new RunnerProcess({ cwd: "/memory-only", args: [], runnerPath: "/memory-only/runner.js", spawnProcess: () => child });
	return runner;
}

const boundedTest = (name: string, fn: () => void | Promise<void>) => it(name, { timeout: 2000 }, fn);

describe("RunnerProcess observed termination", () => {
	boundedTest("treats failed spawn close as terminal even without an exit event", async () => {
		const child = new MockChild();
		const process = createRunner(child);
		const closing = process.closeGracefully(10);
		child.emit("error", new Error("spawn ENOENT"));
		child.emit("close", null, null);

		await closing;
		const observed = await process.observedExit;
		assert.equal(observed.kind, "spawn-failure");
		assert.equal(observed.code, null);
		assert.equal(observed.signal, null);
		if (observed.kind === "spawn-failure") assert.equal(observed.error.message, "Runner process failed to spawn");
		assert.equal(child.closeInputCalls, 1);
	});

	boundedTest("keeps a live process error distinct from termination until exit is observed", async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const child = new MockChild();
			const process = createRunner(child);
			child.emit("spawn");
			child.emit("error", new Error("process error"));
			const closing = process.closeGracefully(10);
			await mock.timers.tick(1000);
			await Promise.resolve();
			await Promise.resolve();
			assert.equal(child.closeInputCalls, 1);
			mock.timers.tick(10);
			await Promise.resolve();
			assert.equal(child.killCalls, 1);
			let settled = false;
			void closing.then(() => { settled = true; });
			await Promise.resolve();
			assert.equal(settled, false);
			assert.equal(process.exited, false);

			child.emit("exit", null, "SIGKILL");
			await closing;
			assert.deepEqual(await process.observedExit, { kind: "exit", code: null, signal: "SIGKILL" });
			assert.equal(process.exited, true);
		} finally {
			mock.timers.reset();
		}
	});

	boundedTest("observes a normal exit without waiting for close", async () => {
		const child = new MockChild();
		const process = createRunner(child);
		child.emit("spawn");
		child.emit("exit", 0, null);

		assert.deepEqual(await process.observedExit, { kind: "exit", code: 0, signal: null });
		assert.equal(process.exited, true);
	});
});
