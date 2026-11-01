import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function getAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim();
	if (override && override.length > 0) return resolve(override);
	return join(homedir(), ".pi", "agent");
}
