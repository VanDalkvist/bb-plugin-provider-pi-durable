import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getPiDurableVersion } from "../src/runner/version.ts";

test("candidate pins one exact Pi 1.4 ecosystem without mixing SDK upgrade", () => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	for (const name of ["pi-durable", "pi-coding-agent", "pi-codemode"]) assert.equal(pkg.dependencies[`@earendil-works/${name}`], "1.4.0");
	for (const name of ["chord", "pi-ai"]) assert.equal(pkg.overrides[`@earendil-works/${name}`], "1.4.0");
	assert.equal(pkg.dependencies["@get-bb/plugin-sdk"], "0.6.79");
	assert.equal(getPiDurableVersion(), "1.4.0");
});
