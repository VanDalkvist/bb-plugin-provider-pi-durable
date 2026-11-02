import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const candidates = [
	join(rootDir, "node_modules", "durable-zero", "packages", "core", "dist"),
	join(rootDir, "node_modules", "@durable-zero", "core", "dist"),
	join(rootDir, "..", "durable-zero", "packages", "core", "dist"),
];

const coreDist = candidates.find((dir) => existsSync(dir));

if (!coreDist) {
	console.warn(`[copy-runner-assets] Warning: core dist not found in candidates, skipping runner copy`);
	process.exit(0);
}

const runnerSrc = join(coreDist, "runner.js");
const wasmSrc = join(coreDist, "quickjs.wasm");

if (existsSync(runnerSrc)) {
	const distRunnerDir = join(rootDir, "dist", "runner");
	mkdirSync(distRunnerDir, { recursive: true });
	copyFileSync(runnerSrc, join(distRunnerDir, "index.js"));
	copyFileSync(runnerSrc, join(rootDir, "dist", "runner.js"));
	console.log("[copy-runner-assets] Synced runner.js to dist/runner/index.js and dist/runner.js");
}

if (existsSync(wasmSrc)) {
	const distRunnerDir = join(rootDir, "dist", "runner");
	copyFileSync(wasmSrc, join(distRunnerDir, "quickjs.wasm"));
	copyFileSync(wasmSrc, join(rootDir, "dist", "quickjs.wasm"));
	console.log("[copy-runner-assets] Synced quickjs.wasm to dist/");
}
