import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getBbDataDir } from "./paths.ts";
import { nativeChildTitle } from "../shared/child-title.ts";
import { formatSubagentMirrorPrompt } from "../shared/subagent-envelope.ts";

const execFileAsync = promisify(execFile);

export interface SubthreadSpawnArgs {
	projectId?: string;
	environmentId?: string;
	parentThreadId: string;
	title: string;
	task: string;
	sessionKey?: string;
	conversationId?: string;
	actualModel?: { provider: string; modelId: string };
	thinkingLevel?: string;
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
	parentThreadId?: string;
	prompt?: string;
}

function extractPromptFromStartupContext(rawContext: unknown): string | undefined {
	if (typeof rawContext !== "string" || !rawContext.trim()) return undefined;
	try {
		const parsed = JSON.parse(rawContext) as Record<string, unknown>;
		const request = parsed.request && typeof parsed.request === "object" ? (parsed.request as Record<string, unknown>) : parsed;
		const input = Array.isArray(request.input) ? request.input : undefined;
		if (!input) return undefined;
		const parts: string[] = [];
		for (const item of input) {
			if (item && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string") {
				const text = ((item as Record<string, unknown>).text as string).trim();
				if (text) parts.push(text);
			}
		}
		return parts.length > 0 ? parts.join("\n") : undefined;
	} catch (err) {
		console.warn(`[SubthreadSpawner] Failed to parse startup_context JSON: ${err}`);
		return undefined;
	}
}

export function resolveThreadContextFromDb(threadId: string): ThreadContextRecord | undefined {
	try {
		const dbPath = join(getBbDataDir(), "bb.db");
		if (!existsSync(dbPath)) return undefined;
		const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
		try {
			const query = db.prepare("SELECT project_id, environment_id, parent_thread_id, startup_context FROM threads WHERE id = ?");
			const row = query.get(threadId);
			if (!row || typeof row !== "object") return undefined;
			const r = row as Record<string, unknown>;
			return {
				projectId: typeof r.project_id === "string" ? r.project_id : undefined,
				environmentId: typeof r.environment_id === "string" ? r.environment_id : undefined,
				parentThreadId: typeof r.parent_thread_id === "string" ? r.parent_thread_id : undefined,
				prompt: extractPromptFromStartupContext(r.startup_context),
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

	const prompt =
		args.sessionKey && args.conversationId
			? formatSubagentMirrorPrompt(args.sessionKey, args.parentThreadId, args.conversationId, args.task)
			: args.task;

	const cliArgs = [
		"thread",
		"spawn",
		"--project",
		projectId,
		"--parent-thread",
		args.parentThreadId,
		"--title",
		nativeChildTitle(args.title),
		"--prompt",
		prompt,
		"--provider",
		"pi-durable",
		"--json",
	];

	if (environmentId) {
		cliArgs.push("--environment", environmentId);
	}

	if (args.actualModel?.provider && args.actualModel?.modelId) {
		cliArgs.push("--model", `${args.actualModel.provider}/${args.actualModel.modelId}`);
	}
	if (args.thinkingLevel) {
		const level = args.thinkingLevel === "off" ? "none" : args.thinkingLevel;
		cliArgs.push("--reasoning-level", level);
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
