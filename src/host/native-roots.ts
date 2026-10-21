import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ResolvedSkillRoot {
	path: string;
	origin: "user" | "project";
	recursive: boolean;
	shape: "skills";
}

export function resolvePiNativeRoots(env: NodeJS.ProcessEnv = process.env): { skills: ResolvedSkillRoot[] } {
	const home = homedir();
	const agentDir = env.PI_AGENT_DIR?.trim() || join(home, ".pi", "agent");
	const candidates = new Set<string>();

	candidates.add(resolve(agentDir, "skills"));
	candidates.add(resolve(home, ".agents", "skills"));

	const settingsPath = join(agentDir, "settings.json");
	if (existsSync(settingsPath)) {
		try {
			const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
			if (Array.isArray(parsed?.skills)) {
				for (const raw of parsed.skills) {
					if (typeof raw === "string" && raw.trim() && !raw.trim().startsWith("!")) {
						const trimmed = raw.trim();
						const resolved = trimmed.startsWith("~")
							? join(home, trimmed.slice(1))
							: resolve(agentDir, trimmed);
						candidates.add(resolved);
					}
				}
			}
		} catch {
			// Ignore malformed settings
		}
	}

	const existing = Array.from(candidates).filter((p) => existsSync(p));
	return {
		skills: existing.map((path) => ({
			path,
			origin: "user",
			recursive: true,
			shape: "skills",
		})),
	};
}
