import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ProviderInstallationAction {
	kind: "install" | "update";
	label: "Install" | "Update";
	command: string;
}

export type ProviderInstallationSource = "notInstalled" | "npmGlobal" | "external";

export interface ProviderInstallationStatus {
	executableName: string;
	executablePath: string | null;
	installed: boolean;
	installSource: ProviderInstallationSource;
	currentVersion: string | null;
	latestVersion: string | null;
	minimumSupportedVersion: string | null;
	npmPackageName: string | null;
	npmGlobalPackageVersion: string | null;
	installAction: ProviderInstallationAction | null;
	needsUpdate: boolean;
	versionUnsupported: boolean;
}

export type ProviderInstallationRunResult =
	| {
			available: true;
			command: {
				command: string;
				args: string[];
				displayCommand: string;
			};
			verification:
				| { kind: "installed" }
				| { kind: "version_changed"; previousVersion: string }
				| { kind: "version_at_least"; version: string };
	  }
	| {
			available: false;
			message: string;
	  };

const PLUGIN_PACKAGE_NAME = "bb-plugin-provider-pi-durable";
const PLUGIN_EXECUTABLE_NAME = "bb";
const MINIMUM_SUPPORTED_VERSION = "0.2.0";

let cachedPluginVersion: string | null = null;
let cachedLatestVersion: { version: string | null; fetchedAt: number } | null = null;
const LATEST_CACHE_TTL_MS = 60000;

export function resolvePluginVersion(): string {
	if (cachedPluginVersion !== null) return cachedPluginVersion;
	try {
		const currentDir = dirname(fileURLToPath(import.meta.url));
		const candidates = [
			join(currentDir, "..", "..", "package.json"),
			join(currentDir, "..", "package.json"),
			join(process.cwd(), "package.json"),
		];
		for (const candidate of candidates) {
			if (existsSync(candidate)) {
				const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
				if (parsed.name === PLUGIN_PACKAGE_NAME && typeof parsed.version === "string" && parsed.version.length > 0) {
					cachedPluginVersion = parsed.version;
					return cachedPluginVersion;
				}
			}
		}
	} catch {
		// intentional fallback if file read or parse fails
	}
	cachedPluginVersion = "0.2.22";
	return cachedPluginVersion;
}

export function resetPluginVersionCacheForTesting(): void {
	cachedPluginVersion = null;
	cachedLatestVersion = null;
}

export function compareSemver(a: string, b: string): number {
	const pa = a.split(".").map(part => parseInt(part, 10) || 0);
	const pb = b.split(".").map(part => parseInt(part, 10) || 0);
	for (let i = 0; i < 3; i++) {
		const na = pa[i] ?? 0;
		const nb = pb[i] ?? 0;
		if (na > nb) return 1;
		if (na < nb) return -1;
	}
	return 0;
}

export async function fetchLatestVersion(packageName = PLUGIN_PACKAGE_NAME): Promise<string | null> {
	const now = Date.now();
	if (cachedLatestVersion !== null && now - cachedLatestVersion.fetchedAt < LATEST_CACHE_TTL_MS) {
		return cachedLatestVersion.version;
	}
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 2000);
		const res = await fetch(`https://registry.npmjs.org/${packageName}`, {
			signal: controller.signal,
			headers: { Accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8" },
		});
		clearTimeout(timer);
		if (res.ok) {
			const data = (await res.json()) as { "dist-tags"?: { latest?: string } };
			const latest = typeof data?.["dist-tags"]?.latest === "string" ? data["dist-tags"].latest : null;
			cachedLatestVersion = { version: latest, fetchedAt: now };
			return latest;
		}
	} catch {
		// safe offline / timeout fallback
	}
	cachedLatestVersion = { version: null, fetchedAt: now };
	return null;
}

export async function getProviderInstallationStatus(
	options: { checkUpdates?: boolean } = {},
): Promise<ProviderInstallationStatus> {
	const currentVersion = resolvePluginVersion();
	const latestVersion = options.checkUpdates !== false ? await fetchLatestVersion() : null;
	const needsUpdate =
		latestVersion !== null && currentVersion !== null && compareSemver(latestVersion, currentVersion) > 0;
	const versionUnsupported =
		MINIMUM_SUPPORTED_VERSION !== null &&
		currentVersion !== null &&
		compareSemver(currentVersion, MINIMUM_SUPPORTED_VERSION) < 0;

	const installAction: ProviderInstallationAction = {
		kind: "update",
		label: "Update",
		command: "bb plugin update provider-pi-durable",
	};

	return {
		executableName: PLUGIN_EXECUTABLE_NAME,
		executablePath: process.execPath,
		installed: true,
		installSource: "external",
		currentVersion,
		latestVersion,
		minimumSupportedVersion: MINIMUM_SUPPORTED_VERSION,
		npmPackageName: PLUGIN_PACKAGE_NAME,
		npmGlobalPackageVersion: null,
		installAction,
		needsUpdate,
		versionUnsupported,
	};
}

export async function getProviderInstallationRun(
	action: "install" | "update",
): Promise<ProviderInstallationRunResult> {
	const status = await getProviderInstallationStatus({ checkUpdates: false });
	if (action !== "install" && action !== "update") {
		return { available: false, message: `Unsupported installation action: ${String(action)}` };
	}
	const verification =
		status.latestVersion !== null
			? { kind: "version_at_least" as const, version: status.latestVersion }
			: { kind: "version_changed" as const, previousVersion: status.currentVersion ?? "0.2.22" };

	return {
		available: true,
		command: {
			command: "bb",
			args: ["plugin", "update", "provider-pi-durable"],
			displayCommand: "bb plugin update provider-pi-durable",
		},
		verification,
	};
}
