import test from "node:test";
import assert from "node:assert/strict";
import { unwrapWatchValue, isWatchCall } from "../src/runner/watcher-compat.ts";

test("WatcherCompat: extracts value from v1.5 WatchCall ({ kind: 'value', value })", () => {
	const call = { kind: "value" as const, value: { deliveryHold: false }, ops: [] };
	assert.equal(isWatchCall(call), true);
	assert.deepEqual(unwrapWatchValue(call), { deliveryHold: false });
});

test("WatcherCompat: preserves raw value from v1.4 watch callback", () => {
	const rawValue = { deliveryHold: true };
	assert.equal(isWatchCall(rawValue), false);
	assert.deepEqual(unwrapWatchValue(rawValue), { deliveryHold: true });
});
