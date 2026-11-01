import test from "node:test";
import assert from "node:assert/strict";
import { normalizeModelReference, formatModelCliArg } from "../src/shared/model-ref.ts";

test("normalizeModelReference handles { provider, modelId } and { provider, id }", { timeout: 3000 }, () => {
	assert.deepEqual(
		normalizeModelReference({ provider: "antigravity", modelId: "gemini-3.8-flash" }),
		{ provider: "antigravity", modelId: "gemini-3.8-flash" },
	);
	assert.deepEqual(
		normalizeModelReference({ provider: "antigravity", id: "gemini-3.8-flash" }),
		{ provider: "antigravity", modelId: "gemini-3.8-flash" },
	);
});

test("normalizeModelReference strips redundant provider prefix from modelId", { timeout: 3000 }, () => {
	assert.deepEqual(
		normalizeModelReference({ provider: "antigravity", modelId: "antigravity/gemini-3.8-flash" }),
		{ provider: "antigravity", modelId: "gemini-3.8-flash" },
	);
	assert.deepEqual(
		normalizeModelReference({ provider: "openrouter", id: "openrouter/google/gemini-2.5-flash" }),
		{ provider: "openrouter", modelId: "google/gemini-2.5-flash" },
	);
});

test("formatModelCliArg generates single clean provider/modelId argument", { timeout: 3000 }, () => {
	assert.equal(
		formatModelCliArg({ provider: "antigravity", modelId: "antigravity/gemini-3.8-flash" }),
		"antigravity/gemini-3.8-flash",
	);
	assert.equal(
		formatModelCliArg({ provider: "antigravity", modelId: "gemini-3.8-flash" }),
		"antigravity/gemini-3.8-flash",
	);
});
