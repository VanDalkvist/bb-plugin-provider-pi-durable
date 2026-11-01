#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { builtinModules } from "node:module";
import fs from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

console.log("Building Pi Durable internal runner...");

await build({
	entryPoints: [resolve(projectRoot, "src/runner/index.ts")],
	bundle: true,
	platform: "node",
	target: "node22",
	format: "esm",
	outfile: resolve(projectRoot, "dist/runner/index.js"),
	external: [
		...builtinModules,
		...builtinModules.map((m) => `node:${m}`),
		"@earendil-works/pi-durable",
		"@earendil-works/pi-durable/*",
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-coding-agent/*",
		"@earendil-works/pi-codemode",
		"@earendil-works/pi-codemode/*",
		"@earendil-works/pi-ai",
		"@earendil-works/pi-ai/*",
		"@earendil-works/chord",
		"@earendil-works/chord/*",
		"proper-lockfile",
		"zod",
		"zod/*",
	],
	banner: {
		js: `import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);`,
	},
	sourcemap: true,
});

console.log("Built dist/runner/index.js successfully!");

try {
	const wasmSource = resolve(projectRoot, "node_modules/quickjs-wasi/quickjs.wasm");
	const wasmDest = resolve(projectRoot, "dist/runner/quickjs.wasm");
	await fs.copyFile(wasmSource, wasmDest);
	console.log("Copied quickjs.wasm to dist/runner/quickjs.wasm successfully!");
} catch (err) {
	console.warn("Could not copy quickjs.wasm to dist/runner:", err);
}
