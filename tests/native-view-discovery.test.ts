import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderBridge } from "../src/host/bridge.ts";

test("production bridge initializes with no fork capability when native source identity cannot be preserved", async () => {
	const frames: Array<{ id?: number; result?: { capabilities?: { fork?: string } } }> = [];
	const bridge = new ProviderBridge((line) => frames.push(JSON.parse(line)));
	await bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
	assert.equal(frames.find((frame) => frame.id === 1)?.result?.capabilities?.fork, "none");
	await bridge.shutdown();
});
