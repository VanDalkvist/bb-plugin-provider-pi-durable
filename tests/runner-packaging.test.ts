import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

test("runner packaging: externalizing zod keeps bundled runner small (<20KB) and schema functional", async () => {
	const projectRoot = path.resolve(import.meta.dirname, "..");
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-pack-test-"));

	try {
		const fixtureScripts = path.join(tmpDir, "scripts");
		const fixtureSrcRunner = path.join(tmpDir, "src", "runner");
		fs.mkdirSync(fixtureScripts, { recursive: true });
		fs.mkdirSync(fixtureSrcRunner, { recursive: true });

		// Copy actual production build script into fixture/scripts
		const buildScriptSrc = fs.readFileSync(path.join(projectRoot, "scripts", "build-runner.mjs"), "utf8");
		fs.writeFileSync(path.join(fixtureScripts, "build-runner.mjs"), buildScriptSrc, "utf8");

		// Fixture entry imports Zod and exports a schema
		const entrySrc = `
import { z } from "zod";
export const testSchema = z.object({ ok: z.boolean() });
`;
		fs.writeFileSync(path.join(fixtureSrcRunner, "index.ts"), entrySrc, "utf8");

		// Symlink node_modules to fixture
		fs.symlinkSync(path.join(projectRoot, "node_modules"), path.join(tmpDir, "node_modules"), "junction");

		// Run build script inside fixture
		execFileSync(process.execPath, [path.join(fixtureScripts, "build-runner.mjs")], {
			cwd: tmpDir,
			stdio: "pipe",
		});

		const outfile = path.join(tmpDir, "dist", "runner", "index.js");
		assert.ok(fs.existsSync(outfile), "Output file must exist");

		const stat = fs.statSync(outfile);
		// If zod is not externalized, bundle is ~700KB. When externalized, it is < 20KB.
		assert.ok(
			stat.size < 20 * 1024,
			`Runner bundle must be < 20KB when Zod is externalized, got ${stat.size} bytes`,
		);

		// Verify exported schema works when imported
		const imported = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
		assert.ok(imported.testSchema, "Exported schema must exist");
		assert.deepEqual(imported.testSchema.parse({ ok: true }), { ok: true });
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});
