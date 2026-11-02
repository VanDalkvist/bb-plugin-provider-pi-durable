import test from "node:test";
import assert from "node:assert/strict";
import { safeCloneRecord } from "../src/runner/session-storage.ts";

test("safeCloneRecord: clones frozen objects so downstream mutation does not throw", () => {
	const frozen = Object.freeze({
		taskId: 42,
		status: "completed",
		nested: Object.freeze({ count: 1 }),
	});

	const clone = safeCloneRecord(frozen);
	assert.doesNotThrow(() => {
		(clone as { status: string }).status = "mutated";
	});
	assert.equal(clone.status, "mutated");
	assert.equal(frozen.status, "completed");
});

test("safeCloneRecord: clones arrays defensively", () => {
	const frozenArr = Object.freeze([1, 2, 3]);
	const clone = safeCloneRecord(frozenArr);
	assert.doesNotThrow(() => {
		(clone as number[]).push(4);
	});
	assert.deepEqual(clone, [1, 2, 3, 4]);
	assert.equal(frozenArr.length, 3);
});
