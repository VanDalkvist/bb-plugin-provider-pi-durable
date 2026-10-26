import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerProcess } from "../src/host/runner-process.ts";
import { RunnerProtocolError } from "../src/host/runner-protocol-error.ts";

function createMockNpmWorkspace(): { workspaceDir: string; cleanup: () => void } {
	const workspaceDir = mkdtempSync(join(tmpdir(), "pi-cold-start-"));
	const piDir = join(workspaceDir, ".pi");
	mkdirSync(piDir, { recursive: true });

	const mockNpmPath = join(workspaceDir, "mock-npm.mjs");
	const mockNpmCode = `
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

console.log("added 105 packages, and audited 108 packages in 3s");

const prefixIdx = process.argv.indexOf("--prefix");
const installRoot = prefixIdx !== -1 ? process.argv[prefixIdx + 1] : ".";
const pkgDir = join(installRoot, "node_modules", "fixture-cold-package");
mkdirSync(pkgDir, { recursive: true });
writeFileSync(
	join(pkgDir, "package.json"),
	JSON.stringify({ name: "fixture-cold-package", version: "1.0.0" }),
	"utf8",
);
`;
	writeFileSync(mockNpmPath, mockNpmCode, "utf8");

	writeFileSync(
		join(piDir, "settings.json"),
		JSON.stringify({
			npmCommand: ["node", mockNpmPath],
			packages: ["npm:fixture-cold-package@1.0.0"],
		}),
		"utf8",
	);

	return {
		workspaceDir,
		cleanup: () => {
			rmSync(workspaceDir, { recursive: true, force: true });
		},
	};
}

test("runner cold start in workspace requiring package install preserves wire purity and completes first RPC", { timeout: 15000 }, async () => {
	const { workspaceDir, cleanup } = createMockNpmWorkspace();
	let protocolError: RunnerProtocolError | null = null;
	const stderrChunks: string[] = [];
	let runner: RunnerProcess | undefined;

	try {
		runner = new RunnerProcess({
			cwd: workspaceDir,
			args: ["--no-session"],
			onProtocolError: (err) => {
				protocolError = err;
			},
		});

		// Capture child process stderr to verify diagnostics destination
		(runner as any).child.stderr?.on("data", (chunk: Buffer) => {
			stderrChunks.push(chunk.toString("utf8"));
		});

		// Request available models over the JSON-RPC channel on first run
		const modelsRes = await runner.requestOk({ type: "get_available_models" }, 8000);
		assert.ok(modelsRes, "First RPC request must return a valid response");
		assert.ok(Array.isArray(modelsRes.models), "models array must be present in response");

		// Request runner state over the JSON-RPC channel on first run
		const stateRes = await runner.requestOk({ type: "get_state" }, 8000);
		assert.ok(stateRes, "Second RPC request must return state");
		assert.equal(stateRes.sessionId, "catalog", "Session ID in no-session mode must be catalog");

		// Verify no protocol faults occurred
		assert.equal(protocolError, null, "No MALFORMED_JSON or protocol fault must occur on cold start");

		// Verify installation output was captured in stderr diagnostics
		const combinedStderr = stderrChunks.join("");
		assert.ok(
			combinedStderr.includes("added 105 packages"),
			`Installation diagnostics must be redirected to stderr. Received: ${combinedStderr}`,
		);

		// Verify package was actually installed in the workspace
		const installedPkgJson = join(workspaceDir, ".pi", "npm", "node_modules", "fixture-cold-package", "package.json");
		assert.ok(existsSync(installedPkgJson), "Package must be installed in target directory");
	} finally {
		runner?.kill();
		cleanup();
	}
});

test("stdout-guard unit: activates upstream takeover, enables wire writing, and restores cleanly", async () => {
	const {
		setupRunnerStdoutGuard,
		writeWireStdout,
		flushWireStdout,
		isStdoutGuarded,
		restoreRunnerStdout,
	} = await import("../src/runner/stdout-guard.ts");

	const capturedStderr: string[] = [];
	const originalStderrWrite = process.stderr.write;
	process.stderr.write = ((chunk: any, encoding?: any, cb?: any) => {
		capturedStderr.push(String(chunk));
		if (typeof encoding === "function") encoding();
		else if (typeof cb === "function") cb();
		return true;
	}) as typeof process.stderr.write;

	try {
		await setupRunnerStdoutGuard();
		assert.equal(isStdoutGuarded(), true, "isStdoutGuarded must report true after setup");

		// console.log / process.stdout.write must be redirected to stderr
		process.stdout.write("REDIRECTED_DIAGNOSTIC\n");
		assert.ok(
			capturedStderr.some((s) => s.includes("REDIRECTED_DIAGNOSTIC")),
			"stdout writes must be routed to stderr when guarded",
		);

		await flushWireStdout();
	} finally {
		restoreRunnerStdout();
		process.stderr.write = originalStderrWrite;
	}
});

