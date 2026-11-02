import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { forkSessionDatabase as coreForkSessionDatabase } from "@durable-zero/core";
import { resolveSessionFilePath } from "./paths.ts";

export interface ForkSessionOptions {
	sourceProviderThreadId: string;
	targetProviderThreadId: string;
	checkpointId?: string | number;
	env?: NodeJS.ProcessEnv;
}

export function forkSessionDatabase(options: ForkSessionOptions): void {
	let sourceDir: string;
	if (
		(options.sourceProviderThreadId.includes("/") || options.sourceProviderThreadId.includes("\\")) &&
		existsSync(options.sourceProviderThreadId)
	) {
		sourceDir = resolve(options.sourceProviderThreadId);
	} else {
		sourceDir = resolveSessionFilePath(options.sourceProviderThreadId, options.env);
	}

	if (!existsSync(join(sourceDir, "session.sqlite"))) {
		if (existsSync(join(options.sourceProviderThreadId, "session.sqlite"))) {
			sourceDir = resolve(options.sourceProviderThreadId);
		}
	}

	let targetDir: string;
	if (options.targetProviderThreadId.includes("/") || options.targetProviderThreadId.includes("\\")) {
		targetDir = resolve(options.targetProviderThreadId);
	} else {
		targetDir = resolveSessionFilePath(options.targetProviderThreadId, options.env);
	}

	if (!existsSync(sourceDir) || !existsSync(join(sourceDir, "session.sqlite"))) {
		throw new Error(`Cannot fork: source session database not found for "${options.sourceProviderThreadId}"`);
	}

	coreForkSessionDatabase({
		sourceDir,
		targetDir,
		checkpointId: options.checkpointId,
	});
}
