/**
 * Strictly isolated compatibility port for upstream Pi 1.4 output takeover.
 *
 * ARCHITECTURAL CAVEAT / RESIDUAL RISK:
 * In Pi 1.4.0 (@earendil-works/pi-coding-agent), DefaultPackageManager.spawnCommand
 * queries `isStdoutTakenOver()` from `./output-guard.ts`. If false, child processes
 * (such as npm install during cold-start resource loading) run with stdio: "inherit",
 * leaking arbitrary text into FD 1 and causing host JSON-RPC protocol faults (D-22).
 *
 * As verified against upstream source code, Pi 1.4 does NOT expose an equivalent
 * public seam (neither in package.json#exports, nor in DefaultResourceLoader options,
 * nor in SettingsManager). This module is an isolated compatibility port that
 * binds directly to exact Pi 1.4.x artifacts with strict runtime shape/version checks.
 *
 * It intentionally DOES NOT provide a silent fallback: if the upstream module
 * cannot be verified or loaded, it fails closed with UpstreamStdoutGuardPortError,
 * preventing unmanaged child process stdout from contaminating the wire.
 */

import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";

export const SUPPORTED_PI_VERSION_PREFIX = "1.4.";
export const EXPECTED_GUARD_RELATIVE_PATH = "dist/core/output-guard.js";

export class UpstreamStdoutGuardPortError extends Error {
	readonly reason: string;

	constructor(message: string, reason: string) {
		super(`[UpstreamStdoutGuardPortError] ${message} (reason: ${reason})`);
		this.name = "UpstreamStdoutGuardPortError";
		this.reason = reason;
	}
}

export interface UpstreamOutputGuard {
	takeOverStdout: () => void;
	restoreStdout: () => void;
	isStdoutTakenOver: () => boolean;
	writeRawStdout: (text: string) => void;
	waitForRawStdoutBackpressure?: () => Promise<void>;
	flushRawStdout?: () => Promise<void>;
}

let activeGuard: UpstreamOutputGuard | null = null;

export function validateUpstreamGuardVersion(version: string): void {
	if (!version.startsWith(SUPPORTED_PI_VERSION_PREFIX)) {
		throw new UpstreamStdoutGuardPortError(
			`Incompatible @earendil-works/pi-coding-agent version: "${version}". Expected ${SUPPORTED_PI_VERSION_PREFIX}x`,
			"INCOMPATIBLE_VERSION",
		);
	}
}

export function validateUpstreamGuardShape(mod: unknown): asserts mod is UpstreamOutputGuard {
	if (!mod || typeof mod !== "object") {
		throw new UpstreamStdoutGuardPortError("Loaded upstream output-guard module is not an object", "INVALID_MODULE");
	}
	const candidate = mod as Record<string, unknown>;
	const requiredFunctions = ["takeOverStdout", "restoreStdout", "isStdoutTakenOver", "writeRawStdout", "flushRawStdout"];
	for (const fn of requiredFunctions) {
		if (typeof candidate[fn] !== "function") {
			throw new UpstreamStdoutGuardPortError(`Missing required upstream output-guard export: ${fn}`, "INVALID_SHAPE");
		}
	}
}

async function loadUpstreamGuard(): Promise<UpstreamOutputGuard> {
	if (activeGuard) return activeGuard;

	const pkgDir = getPackageDir();
	const pkgJsonPath = join(pkgDir, "package.json");
	if (!existsSync(pkgJsonPath)) {
		throw new UpstreamStdoutGuardPortError(`Cannot locate package.json at ${pkgJsonPath}`, "MISSING_PACKAGE_JSON");
	}

	let version: string;
	try {
		const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { version?: string };
		version = pkgJson.version ?? "";
	} catch (err) {
		throw new UpstreamStdoutGuardPortError(
			`Failed to parse @earendil-works/pi-coding-agent package.json: ${err instanceof Error ? err.message : String(err)}`,
			"PARSE_FAILURE",
		);
	}
	validateUpstreamGuardVersion(version);

	const guardPath = join(pkgDir, EXPECTED_GUARD_RELATIVE_PATH);
	if (!existsSync(guardPath)) {
		throw new UpstreamStdoutGuardPortError(`Missing upstream output guard artifact at ${guardPath}`, "MISSING_ARTIFACT");
	}

	let mod: unknown;
	try {
		mod = await import(pathToFileURL(guardPath).href);
	} catch (err) {
		throw new UpstreamStdoutGuardPortError(
			`Failed to dynamically import output guard: ${err instanceof Error ? err.message : String(err)}`,
			"IMPORT_FAILURE",
		);
	}

	validateUpstreamGuardShape(mod);
	activeGuard = mod;
	return mod;
}

export async function setupRunnerStdoutGuard(): Promise<void> {
	const guard = await loadUpstreamGuard();
	guard.takeOverStdout();
	if (!guard.isStdoutTakenOver()) {
		throw new UpstreamStdoutGuardPortError("takeOverStdout() failed to activate takeover state", "ACTIVATION_FAILED");
	}
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
