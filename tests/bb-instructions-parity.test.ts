import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionRegistry } from "../src/host/session-registry.ts";
import { resolveSessionPrompts, writeRunnerPrompts } from "../src/host/runner-prompts.ts";

const instructions = "BB thread management\nUse BB_CLI to list threads, tell agents, and archive completed threads.";

describe("BB instructions parity", () => {
	it("preserves BB append/replace modes and explicit protocol values", () => {
		assert.deepEqual(resolveSessionPrompts({ options: { instructions } }), { systemPrompt: undefined, appendSystemPrompt: instructions });
		assert.deepEqual(resolveSessionPrompts({ instructionMode: "replace", options: { instructions } }), { systemPrompt: instructions, appendSystemPrompt: undefined });
		assert.deepEqual(resolveSessionPrompts({ baseInstructions: "base", appendSystemPrompt: "extra" }), { systemPrompt: "base", appendSystemPrompt: "extra" });
		assert.deepEqual(resolveSessionPrompts({ options: { instructions: "  " } }), { systemPrompt: undefined, appendSystemPrompt: undefined });
	});

	it("writes literal text, not a caller-named file, with isolated paths and cleanup", () => {
		const scratchDir = mkdtempSync(join(tmpdir(), "pi-prompts-test-"));
		try {
			const existing = join(scratchDir, "existing.md");
			writeFileSync(existing, "must not read this");
			const first = writeRunnerPrompts({ scratchDir, appendSystemPrompt: existing, systemPrompt: "base" });
			const second = writeRunnerPrompts({ scratchDir, appendSystemPrompt: instructions });
			assert.equal(readFileSync(first.args[1], "utf8"), "base");
			assert.equal(readFileSync(first.args[3], "utf8"), existing);
			assert.notEqual(first.args[3], second.args[1]);
			if (process.platform !== "win32") assert.equal(statSync(first.args[3]).mode & 0o777, 0o600);
			first.cleanup(); first.cleanup();
			assert.equal(existsSync(first.args[3]), false);
			assert.equal(readFileSync(second.args[1], "utf8"), instructions);
			second.cleanup();
			assert.deepEqual(readdirSync(scratchDir), ["existing.md"]);
		} finally { rmSync(scratchDir, { recursive: true, force: true }); }
	});

	it("does not write a scratch directory without prompt text", () => {
		const result = writeRunnerPrompts();
		assert.deepEqual(result.args, []);
		result.cleanup();
	});

	for (const instructionMode of ["append", "replace"]) {
		it(`renders BB ${instructionMode} instructions through registry → subprocess → real prompt adapter`, async () => {
			const temp = mkdtempSync(join(tmpdir(), "bb-instructions-parity-"));
			const previous = { runner: process.env.PI_DURABLE_RUNNER_PATH, data: process.env.BB_DATA_DIR };
			process.env.PI_DURABLE_RUNNER_PATH = fileURLToPath(new URL("./bb-instructions-fixture.ts", import.meta.url));
			process.env.BB_DATA_DIR = temp;
			const registry = new SessionRegistry(() => {});
			try {
				const session = await registry.createOrGet("fixture-thread", "fixture-provider", {
					cwd: temp, instructionMode, options: { instructions },
				});
				const result = await session.runner.requestOk({ type: "inspect" }) as {
					args: { systemPromptPath?: string; appendSystemPromptPath?: string };
					rendered: { preamble?: string; addendum?: string };
				};
				const path = instructionMode === "replace" ? result.args.systemPromptPath : result.args.appendSystemPromptPath;
				assert.ok(path);
				assert.equal(readFileSync(path, "utf8"), instructions);
				if (instructionMode === "replace") assert.equal(result.rendered.preamble, instructions);
				else assert.ok(result.rendered.addendum?.includes(instructions));
				await registry.stopAll();
				assert.equal(existsSync(path), false, "runner exit must remove its prompt file");
			} finally {
				await registry.stopAll();
				for (const [key, value] of [["PI_DURABLE_RUNNER_PATH", previous.runner], ["BB_DATA_DIR", previous.data]]) {
					if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
				}
				rmSync(temp, { recursive: true, force: true });
			}
		});
	}
});
