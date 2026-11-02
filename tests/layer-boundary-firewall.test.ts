import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBoundaries } from "../scripts/verify-layer-boundaries.mjs";

test("Layer Boundary Firewall: enforces 0 cross-layer boundary violations between Host and Runner", () => {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const violations = verifyBoundaries(root);
	assert.deepEqual(violations, []);
});
