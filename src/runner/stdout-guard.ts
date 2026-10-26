import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface UpstreamOutputGuard {
	takeOverStdout: () => void;
	restoreStdout: () => void;
	isStdoutTakenOver: () => boolean;
	writeRawStdout: (text: string) => void;
	waitForRawStdoutBackpressure?: () => Promise<void>;
	flushRawStdout?: () => Promise<void>;
}

let activeGuard: UpstreamOutputGuard | null = null;
let originalStdoutWrite: typeof process.stdout.write | null = null;

function createFallbackGuard(): UpstreamOutputGuard {
	const rawStdout = process.stdout.write.bind(process.stdout);
	let isGuarded = false;

	return {
		takeOverStdout: () => {
			if (isGuarded) return;
			originalStdoutWrite = process.stdout.write;
			process.stdout.write = ((chunk: any, encoding?: any, cb?: any) => {
				return process.stderr.write(chunk, encoding, cb);
			}) as typeof process.stdout.write;
			isGuarded = true;
		},
		restoreStdout: () => {
			if (!isGuarded) return;
			if (originalStdoutWrite) {
				process.stdout.write = originalStdoutWrite;
				originalStdoutWrite = null;
			}
			isGuarded = false;
		},
		isStdoutTakenOver: () => isGuarded,
		writeRawStdout: (text: string) => {
			rawStdout(text);
		},
		flushRawStdout: async () => {},
	};
}

async function loadUpstreamGuard(): Promise<UpstreamOutputGuard> {
	if (activeGuard) return activeGuard;

	try {
		const pkgDir = getPackageDir();
		const guardPath = join(pkgDir, "dist", "core", "output-guard.js");
		const mod = (await import(pathToFileURL(guardPath).href)) as UpstreamOutputGuard;
		activeGuard = mod;
		return mod;
	} catch (err) {
		console.warn(`[StdoutGuard] Failed to load upstream output-guard: ${err instanceof Error ? err.message : String(err)}`);
		activeGuard = createFallbackGuard();
		return activeGuard;
	}
}

export async function setupRunnerStdoutGuard(): Promise<void> {
	const guard = await loadUpstreamGuard();
	guard.takeOverStdout();
}

export function writeWireStdout(text: string): void {
	if (activeGuard) {
		activeGuard.writeRawStdout(text);
	} else {
		process.stdout.write(text);
	}
}

export async function flushWireStdout(): Promise<void> {
	if (activeGuard?.flushRawStdout) {
		await activeGuard.flushRawStdout();
	}
}

export function isStdoutGuarded(): boolean {
	return activeGuard?.isStdoutTakenOver() ?? false;
}

export function restoreRunnerStdout(): void {
	if (activeGuard) {
		activeGuard.restoreStdout();
	}
}
