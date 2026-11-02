import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { SchemaPort } from "../src/runner/schema-port.ts";

test("SchemaPort: validates and coerces scalar numbers and string inputs", () => {
	const schema = Type.Object({
		count: Type.Number(),
		query: Type.String(),
	});

	const port = new SchemaPort();

	// String numeric coercion parity (pi 1.5 invariant)
	const coerced = port.coerce(schema, { count: "42", query: "test" });
	assert.deepEqual(coerced, { count: 42, query: "test" });

	const result = port.validate(schema, coerced);
	assert.equal(result.isValid, true);
	assert.equal(result.errors, undefined);
});

test("SchemaPort: formats missing fields as canonical pointer errors", () => {
	const schema = Type.Object({
		path: Type.String(),
	});

	const port = new SchemaPort();
	const result = port.validate(schema, {});
	assert.equal(result.isValid, false);
	assert.ok(result.errors && result.errors.length > 0);
	assert.ok(
		result.errors.some((err) => err.includes("path")),
		`Expected error mentioning 'path', got: ${JSON.stringify(result.errors)}`,
	);
});
