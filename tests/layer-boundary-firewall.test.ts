import test from "node:test";
import assert from "node:assert/strict";
import { verifyBoundaries } from "../scripts/verify-layer-boundaries.mjs";

test("Layer Boundary Firewall: enforces 0 cross-layer boundary violations between Host and Runner", () => {
	const violations = verifyBoundaries(process.cwd());
	assert.deepEqual(violations, []);
});
