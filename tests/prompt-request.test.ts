import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiThreadSession } from "../src/host/session.ts";

test("session prompt and steer accept explicit image/conversation DTO and preserve wire", async () => {
	const dir = mkdtempSync(join(tmpdir(), "prompt-dto-"));
	const capture = join(dir, "calls.jsonl"), script = join(dir, "runner.mjs");
	writeFileSync(script, `import {appendFileSync} from "node:fs"; import {createInterface} from "node:readline";
createInterface({input:process.stdin}).on("line",line=>{const c=JSON.parse(line);appendFileSync(${JSON.stringify(capture)},JSON.stringify(c)+"\\n");process.stdout.write(JSON.stringify({id:c.id,type:"response",command:c.type,success:true})+"\\n");});process.stdin.on("end",()=>process.exit(0));`);
	const previous = process.env.PI_DURABLE_RUNNER_PATH;
	process.env.PI_DURABLE_RUNNER_PATH = script;
	const session = new PiThreadSession({
		threadId: "thr_fixture", providerThreadId: "fixture:1", cwd: dir, sessionFilePath: join(dir, "unused.sqlite"),
		sessionDir: dir, extensionPath: script, scratchDir: dir, noSession: true,
	}, () => {});
	try {
		const images = [{ type: "image" as const, data: "AA==", mimeType: "image/png" }];
		await session.prompt({ text: "hello", images, conversationId: "2" });
		await session.steer({ text: "next", conversationId: "2" });
		const calls: unknown[] = readFileSync(capture, "utf8").trim().split("\n").map((s) => JSON.parse(s));
		assert.deepEqual(calls, [
			{ id: "req_1", type: "prompt", message: "hello", images, streamingBehavior: "followUp", conversationId: "2" },
			{ id: "req_2", type: "steer", message: "next", conversationId: "2" },
		]);
		assert.equal(session.isProcessing, false);
	} finally {
		session.kill();
		if (previous === undefined) delete process.env.PI_DURABLE_RUNNER_PATH;
		else process.env.PI_DURABLE_RUNNER_PATH = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});
