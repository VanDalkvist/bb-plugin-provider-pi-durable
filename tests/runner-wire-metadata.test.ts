import test from "node:test";
import assert from "node:assert/strict";
import { runnerEventSchema } from "../src/contracts/runner-event.ts";

test("single assistant message consumed on agent_end is validated, not opaque passthrough metadata", () => {
 assert.equal(runnerEventSchema.safeParse({ type: "agent_end", messages: [], message: 42 }).success, false);
 assert.equal(runnerEventSchema.safeParse({ type: "agent_end", messages: [], message: { role: "assistant", content: [] } }).success, true);
});
