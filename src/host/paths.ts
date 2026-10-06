import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function resolveRunnerPath(): string {
	if (process.env.BB_PI_DURABLE_BRIDGE_COMMAND) {
		const custom = resolve(process.env.BB_PI_DURABLE_BRIDGE_COMMAND);
		if (existsSync(custom)) return custom;
	}

	const candidates = [
		resolve(__dirname, "runner", "index.js"),
		resolve(__dirname, "..", "runner", "index.js"),
		resolve(__dirname, "..", "dist", "runner", "index.js"),
		resolve("/Users/vanya/Projects/bb-plugin-provider-pi-durable/dist/runner/index.js"),
	];

	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}

	throw new Error(
		`Pi Durable internal runner bundle not found. Searched in: ${candidates.join(", ")}. Please run "npm run build" in the plugin directory.`,
	);
}

export function resolveSessionDir(env: NodeJS.ProcessEnv = process.env): string {
	const custom = env.BB_PI_BRIDGE_SESSION_DIR?.trim();
	if (custom) return resolve(custom);
	return join(homedir(), ".bb", "pi-bridge-sessions");
}

export function resolveSessionFilePath(threadId: string, env: NodeJS.ProcessEnv = process.env): string {
	const sanitized = threadId.replace(/[^A-Za-z0-9._-]/g, "_");
	return join(resolveSessionDir(env), `${sanitized}.jsonl`);
}

let activeScratchDir: string | null = null;
export function requireScratchDir(): string {
	if (!activeScratchDir) {
		activeScratchDir = join(tmpdir(), `bb-pi-bridge-${process.pid}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(activeScratchDir, { recursive: true });
	}
	return activeScratchDir;
}

let activeExtensionPath: string | null = null;
export function requireExtensionPath(): string {
	if (!activeExtensionPath) {
		const scratch = requireScratchDir();
		const extFile = join(scratch, "bb-pi-extension.mjs");
		writeFileSync(
			extFile,
			`// Pi Durable BB Bridge stub extension
export default function (pi) {
  // Bridge side channel active
}
`,
			"utf8",
		);
		activeExtensionPath = extFile;
	}
	return activeExtensionPath;
}
