import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ResolveRunnerOptions {
	fromDir?: string;
}

export function resolveRunnerPath(options?: ResolveRunnerOptions): string {
	const envCmd = process.env.BB_PI_DURABLE_BRIDGE_COMMAND?.trim() || process.env.PI_DURABLE_RUNNER_PATH?.trim();
	if (envCmd) {
		const custom = resolve(envCmd);
		if (existsSync(custom)) return custom;
	}

	const baseDir = options?.fromDir ? resolve(options.fromDir) : __dirname;

	const directCandidates = [
		resolve(baseDir, "runner", "index.js"),
		resolve(baseDir, "..", "runner", "index.js"),
		resolve(baseDir, "..", "dist", "runner", "index.js"),
		resolve(baseDir, "..", "..", "dist", "runner", "index.js"),
	];

	for (const candidate of directCandidates) {
		if (existsSync(candidate)) return candidate;
	}

	const parentDir = dirname(baseDir);
	try {
		if (existsSync(parentDir)) {
			const siblings = readdirSync(parentDir, { withFileTypes: true });
			for (const sib of siblings) {
				if (sib.isDirectory()) {
					const sibRunner = resolve(parentDir, sib.name, "dist", "runner", "index.js");
					if (existsSync(sibRunner)) return sibRunner;
					const sibDirectRunner = resolve(parentDir, sib.name, "runner", "index.js");
					if (existsSync(sibDirectRunner)) return sibDirectRunner;
				}
			}
		}
	} catch {
		// intentionally ignored: filesystem permission error during directory walk
	}

	const bbPluginCandidates = [
		join(homedir(), ".bb", "plugins", "provider-pi-durable", "dist", "runner", "index.js"),
		join(homedir(), ".bb", "plugins", "bb-plugin-provider-pi-durable", "dist", "runner", "index.js"),
	];

	for (const candidate of bbPluginCandidates) {
		if (existsSync(candidate)) return candidate;
	}

	const allSearched = [...directCandidates, `${parentDir}/*/dist/runner/index.js`, ...bbPluginCandidates];

	throw new Error(
		`Pi Durable internal runner bundle not found. Searched in: ${allSearched.join(", ")}. Please build the plugin using "npm run build" or set PI_DURABLE_RUNNER_PATH.`,
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
