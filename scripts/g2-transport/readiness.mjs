/**
 * Readiness checker for live G2 transport verification.
 * Verifies that the running BB environment has provider-pi-durable v0.3.x active
 * with the runtime-graph extension state kind registered.
 */

export const CANDIDATE_VERSION = "0.3.0";
export const RUNTIME_GRAPH_EXTENSION_KIND = "provider-pi-durable/runtime-graph";

export function compareSemver(a, b) {
	const pa = (a || "").split(".").map((n) => parseInt(n, 10) || 0);
	const pb = (b || "").split(".").map((n) => parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const na = pa[i] ?? 0;
		const nb = pb[i] ?? 0;
		if (na !== nb) return na - nb;
	}
	return 0;
}

export async function checkProviderReadiness(options = {}) {
	const serverUrl = (options.serverUrl || process.env.BB_SERVER_URL || "http://127.0.0.1:38886").replace(/\/+$/, "");
	const fetchFn = options.fetchFn || fetch;
	const timeoutMs = options.timeoutMs ?? 5000;

	let pluginsData;
	let providersData;

	try {
		const pluginsRes = await fetchFn(`${serverUrl}/api/v1/plugins`, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!pluginsRes.ok) {
			return {
				ready: false,
				outcome: "BLOCKED",
				reason: "server_unhealthy",
				installedVersion: null,
				candidateVersion: CANDIDATE_VERSION,
				hasExtensionKind: false,
				message: `BB server returned HTTP ${pluginsRes.status} for /api/v1/plugins`,
			};
		}
		pluginsData = await pluginsRes.json();
	} catch (err) {
		return {
			ready: false,
			outcome: "BLOCKED",
			reason: "server_unreachable",
			installedVersion: null,
			candidateVersion: CANDIDATE_VERSION,
			hasExtensionKind: false,
			message: `Cannot reach BB server at ${serverUrl}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const pluginsList = Array.isArray(pluginsData) ? pluginsData : pluginsData?.plugins ?? [];
	const plugin = pluginsList.find((p) => p?.id === "provider-pi-durable");

	if (!plugin) {
		return {
			ready: false,
			outcome: "BLOCKED",
			reason: "plugin_not_installed",
			installedVersion: null,
			candidateVersion: CANDIDATE_VERSION,
			hasExtensionKind: false,
			message: "provider-pi-durable is not installed in the running BB instance.",
		};
	}

	const installedVersion = plugin.version ?? null;

	if (compareSemver(installedVersion, CANDIDATE_VERSION) < 0) {
		return {
			ready: false,
			outcome: "BLOCKED",
			reason: "installed_version_outdated",
			installedVersion,
			candidateVersion: CANDIDATE_VERSION,
			hasExtensionKind: false,
			installed: {
				version: installedVersion,
				status: "outdated",
			},
			restart: {
				status: "pending",
			},
			runtime: {
				status: "blocked",
				message: `Installed plugin version is ${installedVersion}, but ${CANDIDATE_VERSION} is required.`,
			},
			message: `Installed plugin version is ${installedVersion}, but ${CANDIDATE_VERSION} is required for runtime graph transport. Run local cutover first.`,
		};
	}

	try {
		const providersRes = await fetchFn(`${serverUrl}/api/v1/system/providers`, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (providersRes.ok) {
			providersData = await providersRes.json();
		}
	} catch {
		// Ignore, will check below
	}

	const providersList = Array.isArray(providersData) ? providersData : [];
	const provider = providersList.find((p) => p?.id === "pi-durable");

	const hasExtensionKind = Boolean(
		provider?.extensionKinds?.[RUNTIME_GRAPH_EXTENSION_KIND] ||
		provider?.extensionKinds?.["runtime-graph"]
	);

	if (!hasExtensionKind) {
		return {
			ready: false,
			outcome: "BLOCKED",
			reason: "extension_kind_missing",
			installedVersion,
			candidateVersion: CANDIDATE_VERSION,
			hasExtensionKind: false,
			installed: {
				version: installedVersion,
				status: "verified",
			},
			restart: {
				status: "unverified",
			},
			runtime: {
				status: "blocked",
				message: `Provider pi-durable is registered but does not declare ${RUNTIME_GRAPH_EXTENSION_KIND} extension state schema.`,
			},
			message: `Provider pi-durable is registered but does not declare ${RUNTIME_GRAPH_EXTENSION_KIND} extension state schema.`,
		};
	}

	return {
		ready: true,
		outcome: "UNVERIFIED",
		reason: "runtime_unverified",
		installedVersion,
		candidateVersion: CANDIDATE_VERSION,
		hasExtensionKind: true,
		installed: {
			version: installedVersion,
			status: "verified",
		},
		restart: {
			status: "unverified",
			message: "Process generation unconfirmed; resident runners may hold earlier version.",
		},
		runtime: {
			status: "unverified",
			message: "Active runtime generation is unverified until fresh native emission is observed.",
		},
		message: `Provider pi-durable v${installedVersion} is installed with extension schema registered. Active runtime generation is unverified until fresh native emission on target thread.`,
	};
}
