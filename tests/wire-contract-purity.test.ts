import test from "node:test";
import assert from "node:assert/strict";
import { lifecycleSchemas } from "../src/contracts/wire-lifecycle.ts";

test("wire-lifecycle: contains zero presentation schemas (no tasks_snapshot)", () => {
	const types = lifecycleSchemas.map((s: any) => s.shape.type.value);
	assert.equal(types.includes("tasks_snapshot"), false, "tasks_snapshot must be purged from wire-lifecycle.ts");
	assert.ok(types.includes("runtime_graph_snapshot"));
});
