import { requireExtensionPath, requireScratchDir, resolveSessionDir, resolveSessionFilePath } from "./paths.ts";
import { resolveSessionPrompts } from "./runner-prompts.ts";
import type { SessionCreationParams } from "./session-port.ts";
import type { SessionOptions } from "./types.ts";

export function buildSessionOptions(
	threadId: string,
	providerThreadId: string,
	sessionKey: string,
	params: SessionCreationParams,
	sharedSkillRoots: readonly string[],
	isNativeChildParent = false,
): SessionOptions {
	const sessionDir = resolveSessionDir(), sessionFilePath = resolveSessionFilePath(sessionKey), extensionPath = requireExtensionPath(), scratchDir = requireScratchDir();
	const rawSkills = (params.additionalSkillPaths as string[]) ?? ((params.options as any)?.additionalSkillPaths as string[]);
	const skillRoots = Array.from(new Set([...(rawSkills ?? []), ...sharedSkillRoots]));
	const rawEnv = params.shellEnvOverrides ?? params.options?.envVars;
	const resolvedEnv = typeof rawEnv === "object" && rawEnv !== null
		? Object.fromEntries(Object.entries(rawEnv as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>
		: undefined;
	const rawProviderOptions = params.options?.providerOptions ?? params.providerOptions;
	const providerOptions = typeof rawProviderOptions === "object" && rawProviderOptions !== null && !Array.isArray(rawProviderOptions) ? (rawProviderOptions as Record<string, unknown>) : undefined;

	if (isNativeChildParent) {
		return {
			threadId, providerThreadId: sessionKey, cwd: params.cwd, sessionFilePath, sessionDir, extensionPath, scratchDir,
			model: undefined, thinkingLevel: undefined, shellEnvOverrides: resolvedEnv,
			...resolveSessionPrompts(params), providerOptions, ...(skillRoots.length > 0 ? { additionalSkillPaths: skillRoots } : {}),
		};
	}

	const rawModel = params.model ?? params.options?.model;
	let resolvedModel: { provider: string; id: string } | undefined;
	if (typeof rawModel === "string") {
		const parts = rawModel.split("/");
		if (parts.length >= 2) resolvedModel = { provider: parts[0], id: parts.slice(1).join("/") };
	} else if (typeof rawModel === "object" && rawModel !== null && "provider" in rawModel && "id" in rawModel) {
		const cand = rawModel as { provider: unknown; id: unknown };
		if (typeof cand.provider === "string" && typeof cand.id === "string") resolvedModel = { provider: cand.provider, id: cand.id };
	}

	const rawThinking = params.thinkingLevel ?? params.options?.reasoningLevel ?? params.options?.thinkingLevel;
	const resolvedThinking = typeof rawThinking === "string" ? rawThinking : undefined;

	return {
		threadId, providerThreadId, cwd: params.cwd, sessionFilePath, sessionDir, extensionPath, scratchDir,
		model: resolvedModel, thinkingLevel: resolvedThinking, shellEnvOverrides: resolvedEnv,
		...resolveSessionPrompts(params), providerOptions, ...(skillRoots.length > 0 ? { additionalSkillPaths: skillRoots } : {}),
	};
}
