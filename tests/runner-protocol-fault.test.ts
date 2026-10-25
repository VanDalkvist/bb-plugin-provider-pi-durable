import test from "node:test";
import assert from "node:assert/strict";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import * as protocol from "../src/host/runner-protocol-error.ts";

test("protocol failure is a real BB provider warning, never a parent terminal outcome", () => {
	assert.equal(typeof protocol.runnerProtocolWarning, "function");
	const delta = protocol.runnerProtocolWarning(new protocol.RunnerProtocolError("INVALID_MESSAGE", new Error("SECRET_MARKER")));
	assert.equal(threadDeltaSchema.safeParse(delta).success, true);
	assert.equal(delta.kind, "provider.warning");
	assert.equal(JSON.stringify(delta).includes("SECRET_MARKER"), false);
	assert.equal(JSON.stringify(delta).includes("turn.boundary"), false);
});
