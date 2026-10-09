import type { ModelCatalog } from "./catalog.ts";
import {
	PROVIDER_BRIDGE_PROTOCOL_VERSION,
	THREAD_DELTA_GRAMMAR_V2,
	THREAD_DELTA_GRAMMAR_V3,
} from "./types.ts";

export async function handleDiscoveryRequest(
	method: string,
	params: any,
	catalog: ModelCatalog,
): Promise<Record<string, unknown> | null> {
	switch (method) {
		case "initialize":
			return {
				protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
				capabilities: {
					sessionRestore: true,
					threadArchive: false,
					threadRename: false,
					threadGoalClear: false,
					fork: "none",
					approvalEnforcedBy: "runtime",
					grammarVersions: [THREAD_DELTA_GRAMMAR_V2, THREAD_DELTA_GRAMMAR_V3],
					steerMode: "inject",
					skills: { configure: true },
				},
			};

		case "model/list": {
			const models = await catalog.listModels();
			return { models, selectedOnlyModels: [] };
		}

		case "provider/health": {
			const health = await catalog.getHealth();
			return health as Record<string, unknown>;
		}

		case "provider/usage":
			return { supported: false };

		case "provider/installation/status":
			return {
				executableName: "pi-durable",
				executablePath: process.execPath,
				installed: true,
				installSource: "external",
				currentVersion: "1.0.4",
				latestVersion: null,
				minimumSupportedVersion: "1.0.0",
				npmPackageName: "@earendil-works/pi-durable",
				npmGlobalPackageVersion: null,
				installAction: null,
				needsUpdate: false,
				versionUnsupported: false,
			};

		case "provider/installation/run":
			return {
				status: "verified",
				currentVersion: "1.0.4",
			};

		default:
			return null;
	}
}
