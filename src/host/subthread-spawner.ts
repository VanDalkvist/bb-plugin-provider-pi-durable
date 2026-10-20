import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getBbDataDir } from "./paths.ts";

const execFileAsync = promisify(execFile);

export interface SubthreadSpawnArgs {
	projectId?: string;
	environmentId?: string;
	parentThreadId: string;
	title: string;
	task: string;
	conversationId?: string;
}

export interface ThreadRegistrationTarget {
	registerThread(threadId: string, conversationId?: string): void;
}

export interface SubthreadSpawnerOptions {
	execCommand?: (cmd: string, args: string[]) => Promise<string>;
}

export interface ThreadContextRecord {
	projectId?: string;
	environmentId?: string;
}

export function resolveThreadContextFromDb(threadId: string): ThreadContextRecord | undefined {
	try {
		const dbPath = join(getBbDataDir(), "bb.db");
		if (!existsSync(dbPath)) return undefined;
		const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
		try {
			const query = db.prepare("SELECT project_id, environment_id FROM threads WHERE id = ?");
			const row = query.get(threadId) as { project_id?: string; environment_id?: string } | undefined;
			return {
				projectId: row?.project_id,
				environmentId: row?.environment_id,
			};
		} finally {
			db.close();
		}
	} catch (err) {
		console.warn(`[SubthreadSpawner] Non-fatal failed to query thread context from db: ${err}`);
		return undefined;
	}
}

export function resolveProjectIdFromDb(threadId: string): string | undefined {
	return resolveThreadContextFromDb(threadId)?.projectId;
}

export function buildSpawnArgs(args: SubthreadSpawnArgs): string[] {
	const dbContext = resolveThreadContextFromDb(args.parentThreadId);
	const projectId =
		args.projectId ||
		process.env.BB_PROJECT_ID ||
		dbContext?.projectId ||
		"proj_personal";

	const environmentId =
		args.environmentId ||
		process.env.BB_ENVIRONMENT_ID ||
		dbContext?.environmentId;

	const cliArgs = [
		"thread",
		"spawn",
		"--project",
		projectId,
		"--parent-thread",
		args.parentThreadId,
		"--title",
		args.title,
		"--prompt",
		args.task,
		"--provider",
		"pi-durable",
		"--json",
	];

	if (environmentId) {
		cliArgs.push("--environment", environmentId);
	}

	return cliArgs;
}

export async function spawnSubthreadInBb(
	args: SubthreadSpawnArgs,
	session: ThreadRegistrationTarget,
	options: SubthreadSpawnerOptions = {},
): Promise<string | undefined> {
	const cliArgs = buildSpawnArgs(args);
	try {
		let output = "";
		if (options.execCommand) {
			output = await options.execCommand("bb", cliArgs);
		} else {
			const cliBinary = process.env.BB_CLI || "bb";
			const res = await execFileAsync(cliBinary, cliArgs, {
				timeout: 15000,
				env: { ...process.env },
			});
			output = res.stdout;
		}

		const parsed = JSON.parse(output.trim());
		if (parsed && typeof parsed.id === "string") {
			session.registerThread(parsed.id, args.conversationId);
			return parsed.id;
		}
	} catch (err: unknown) {
		console.warn(
			`[SubthreadSpawner] Failed to spawn BB child thread for conversation ${args.conversationId}: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err },
		);
	}
	return undefined;
}
