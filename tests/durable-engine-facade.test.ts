import test from "node:test";
import assert from "node:assert/strict";
import { DurableEngine } from "../src/runner/engine.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

test("DurableEngine: provides a cohesive in-process facade for headless library usage", async () => {
	const sessionDir = mkdtempSync(join(tmpdir(), "pi-engine-facade-"));
	try {
		const engine = await DurableEngine.open({ sessionDir });
		assert.ok(engine);
		assert.equal(typeof engine.prompt, "function");
		assert.equal(typeof engine.events, "function");
		assert.equal(typeof engine.close, "function");
		await engine.close();
	} finally {
		rmSync(sessionDir, { recursive: true, force: true });
	}
});
