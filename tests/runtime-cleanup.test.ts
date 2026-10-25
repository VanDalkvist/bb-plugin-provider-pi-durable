import test from "node:test";
import assert from "node:assert/strict";
import { closeRuntimeResources } from "../src/runner/runtime-cleanup.ts";

test("runtime cleanup tries every owned teardown in order and retains failures", async () => {
 const calls: string[] = [];
 const cause = new Error("CLEANUP_FIRST_FAILED");
 await assert.rejects(closeRuntimeResources([
  () => { calls.push("bindings"); throw cause; },
  async () => { calls.push("harness"); },
  () => { calls.push("location"); },
 ]), (error: unknown) => {
  assert.ok(error instanceof AggregateError);
  assert.equal(error.errors[0], cause);
  return true;
 });
 assert.deepEqual(calls, ["bindings", "harness", "location"]);
});
