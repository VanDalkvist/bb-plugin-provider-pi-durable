import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

function atLeast(version: string, minimum: [number, number, number]): boolean {
	const current = version.split(".").map(Number);
	for (let i = 0; i < minimum.length; i++) {
		if (current[i] > minimum[i]) return true;
		if (current[i] < minimum[i]) return false;
	}
	return true;
}

test("resolved validators and HTTP client exclude measured October 2026 advisory ranges", () => {
	assert.ok(atLeast(require("zod/package.json").version, [4, 6, 6]), "Zod collection memory advisory requires >=4.6.6");
	assert.ok(atLeast(require("undici/package.json").version, [8, 12, 2]), "Undici parser/SRI/content-encoding advisories require >=8.12.2");
});
