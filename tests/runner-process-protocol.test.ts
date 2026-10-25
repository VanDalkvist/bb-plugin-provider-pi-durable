import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter, once } from "node:events";
import { RunnerProcess } from "../src/host/runner-process.ts";
import { RunnerProtocolError } from "../src/host/runner-protocol-error.ts";

test("real isolated runner protocol fault surfaces without killing work or replaying requests", { timeout: 5000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "wire-fault-"));
	const script = join(dir, "runner.mjs");
	writeFileSync(script, 'process.stdin.resume(); process.stdin.on("end",()=>process.exit(0)); setTimeout(()=>process.stdout.write(JSON.stringify({type:"tool_execution_start",toolName:33})+"\\n"),20);');
	const previous = process.env.PI_DURABLE_RUNNER_PATH;
	process.env.PI_DURABLE_RUNNER_PATH = script;
	const events = new EventEmitter();
	const fault = once(events, "fault");
	let runner: RunnerProcess | undefined;
	try {
		runner = new RunnerProcess({ cwd: dir, args: [], onProtocolError: (error) => events.emit("fault", error) });
		const values: unknown[] = await fault;
		assert.ok(values[0] instanceof RunnerProtocolError);
		assert.equal(values[0].code, "INVALID_MESSAGE");
		assert.equal(runner.exited, false, "observation fault does not invent native task termination");
		await assert.rejects(runner.request({ type: "get_state" }, 100), /INVALID_MESSAGE/);
		assert.equal(runner.pendingRequests.size, 0);
	} finally {
		runner?.kill();
		if (previous === undefined) delete process.env.PI_DURABLE_RUNNER_PATH;
		else process.env.PI_DURABLE_RUNNER_PATH = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});
