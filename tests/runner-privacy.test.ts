import test from "node:test";
import assert from "node:assert/strict";
import { RunnerRpcChannel } from "../src/host/runner-rpc-channel.ts";

test("protocol diagnostics never log raw JSON, arbitrary type or foreign error content", () => {
	const lines: unknown[][] = [];
	const error = console.error, warn = console.warn;
	console.error = (...args: unknown[]) => { lines.push(args); };
	console.warn = (...args: unknown[]) => { lines.push(args); };
	try {
		const channel = new RunnerRpcChannel();
		assert.throws(() => channel.feedStdout(Buffer.from('{SECRET_PRIVATE_PROMPT\n'), () => {}), /MALFORMED_JSON/);
		const unknown = new RunnerRpcChannel();
		for (let i = 0; i < 100; i++) {
			unknown.feedStdout(Buffer.from('{"type":"SECRET_PRIVATE_PROMPT","error":"SECRET_PRIVATE_PROMPT"}\n'), () => {});
		}
		assert.ok(lines.length <= 4, "diagnostics are bounded per channel");
		assert.ok(!JSON.stringify(lines).includes("SECRET_PRIVATE_PROMPT"));
	} finally {
		console.error = error; console.warn = warn;
	}
});
