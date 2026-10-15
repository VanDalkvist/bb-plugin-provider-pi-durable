import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SessionPrompts {
	systemPrompt?: string;
	appendSystemPrompt?: string;
}

/** Adapt BB turn instructions without owning or rewriting their contents. */
export function resolveSessionPrompts(params: SessionPrompts & {
	baseInstructions?: string;
	instructionMode?: string;
	options?: { instructions?: string };
}): SessionPrompts {
	const instructions = params.options?.instructions?.trim() || undefined;
	return {
		systemPrompt: params.systemPrompt ?? params.baseInstructions
			?? (params.instructionMode === "replace" ? instructions : undefined),
		appendSystemPrompt: params.appendSystemPrompt
			?? (params.instructionMode === "replace" ? undefined : instructions),
	};
}

/** Runner CLI accepts file paths, not the prompt text accepted by the BB port. */
export function writeRunnerPrompts(options?: SessionPrompts & { scratchDir: string }): {
	args: string[];
	cleanup: () => void;
} {
	const args: string[] = [];
	if (!options || (options.systemPrompt === undefined && options.appendSystemPrompt === undefined)) {
		return { args, cleanup() {} };
	}
	mkdirSync(options.scratchDir, { recursive: true, mode: 0o700 });
	const dir = mkdtempSync(join(options.scratchDir, "pi-prompts-"));
	const cleanup = () => rmSync(dir, { recursive: true, force: true });
	try {
		for (const [flag, text] of [
			["system-prompt", options.systemPrompt],
			["append-system-prompt", options.appendSystemPrompt],
		] as const) {
			if (text === undefined) continue;
			const path = join(dir, `${flag}.md`);
			writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
			args.push(`--${flag}`, path);
		}
		return { args, cleanup };
	} catch (error) {
		cleanup();
		throw error;
	}
}
