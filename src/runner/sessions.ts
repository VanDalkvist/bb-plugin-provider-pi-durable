import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import lockfile from "proper-lockfile";

export function getAgentDir(): string {
	const override = process.env.PI_AGENT_DIR;
	if (override && override.trim().length > 0) {
		return resolve(override.trim());
	}
	return join(homedir(), ".pi", "agent");
}

/** One session directory holding `session.sqlite`, locked by this process. */
export interface SessionLocation {
	id: string;
	directory: string;
	database: string;
	cwd: string;
	created: boolean;
	release(): Promise<void>;
}

/** A new session for `cwd`, its newest one with `continueSession`, or a specific session. */
export async function selectSession(
	cwdInput: string,
	continueSession: boolean,
	targetSession?: string,
): Promise<SessionLocation> {
	const cwd = await realpath(resolve(cwdInput));
	const root = join(
		getAgentDir(),
		"experimental",
		"durable-sessions",
		createHash("sha256").update(cwd).digest("hex").slice(0, 24),
	);
	await mkdir(root, { recursive: true });

	let directory: string;
	let created = false;
	if (targetSession) {
		if (targetSession.includes("/") || targetSession.includes("\\")) {
			directory = targetSession.endsWith(".sqlite") ? resolve(targetSession, "..") : resolve(targetSession);
		} else {
			directory = join(root, targetSession);
		}
		try {
			await mkdir(directory, { recursive: true });
			const entries = await readdir(directory);
			created = !entries.includes("session.sqlite");
		} catch {
			created = false;
		}
	} else if (continueSession) {
		const entries = await readdir(root, { withFileTypes: true });
		const newest = entries
			.filter((entry) => entry.isDirectory() && /^\d{13}-[0-9a-f-]{36}$/u.test(entry.name))
			.map((entry) => entry.name)
			.sort()
			.at(-1);
		if (!newest) throw new Error(`No durable session exists for ${cwd}`);
		directory = join(root, newest);
	} else {
		directory = join(root, `${String(Date.now()).padStart(13, "0")}-${randomUUID()}`);
		await mkdir(directory);
		created = true;
	}

	let release: () => Promise<void>;
	try {
		// A lock left by a crashed process goes stale after 10 s; wait that long before giving up.
		release = await lockfile.lock(directory, {
			realpath: false,
			retries: { retries: 12, minTimeout: 1000, maxTimeout: 1000 },
		});
	} catch (error) {
		throw new Error(`Session is already open in another process: ${directory}`, { cause: error });
	}
	return { id: basename(directory), directory, database: join(directory, "session.sqlite"), cwd, created, release };
}
