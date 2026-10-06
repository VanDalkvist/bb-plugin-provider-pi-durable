import { existsSync, readFileSync } from "node:fs";
import { defineExtension, type PromptInput, section } from "@earendil-works/pi-durable";
import {
	type Skill,
	formatSkillsForPrompt,
	loadProjectContextFiles,
	loadSkills,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "./sessions.ts";

export interface PromptOptions {
	systemPromptPath?: string;
	appendSystemPromptPath?: string;
}

const KEYS = ["preamble", "tools", "rules", "docs", "project_context", "skills", "append_prompt", "cwd"] as const;

export function createPiPrompt(
	settings: SettingsManager,
	fallbackCwd: string,
	options: PromptOptions = {},
) {
	const resources = new Map<string, { contextFiles: { path: string; content: string }[]; skills: Skill[] }>();

	const load = (cwd: string) => {
		let found = resources.get(cwd);
		if (found === undefined) {
			const agentDir = getAgentDir();
			found = {
				contextFiles: loadProjectContextFiles({ cwd, agentDir }),
				skills: loadSkills({ cwd, agentDir, skillPaths: settings.getSkillPaths(), includeDefaults: true }).skills,
			};
			resources.set(cwd, found);
		}
		return found;
	};

	let appendedContent = "";
	if (options.appendSystemPromptPath && existsSync(options.appendSystemPromptPath)) {
		try {
			appendedContent = readFileSync(options.appendSystemPromptPath, "utf8").trim();
		} catch (err) {
			console.error(`Warning: failed to read append-system-prompt: ${err}`);
		}
	}

	let systemPromptOverride = "";
	if (options.systemPromptPath && existsSync(options.systemPromptPath)) {
		try {
			systemPromptOverride = readFileSync(options.systemPromptPath, "utf8").trim();
		} catch (err) {
			console.error(`Warning: failed to read system-prompt: ${err}`);
		}
	}

	const built = new WeakMap<PromptInput, Record<string, string>>();

	const build = (input: PromptInput): Record<string, string> => {
		let sections = built.get(input);
		if (sections === undefined) {
			sections = buildSections(input);
			built.set(input, sections);
		}
		return sections;
	};

	const buildSections = (input: PromptInput): Record<string, string> => {
		const cwd = input.env?.cwd ?? input.agent.cwd ?? fallbackCwd;
		const { contextFiles, skills } = load(cwd);

		const sections: Record<string, string> = {};

		if (systemPromptOverride) {
			sections.preamble = systemPromptOverride;
		}

		if (contextFiles && contextFiles.length > 0) {
			sections.project_context = contextFiles
				.map((cf) => `<project_instructions path="${cf.path}">\n${cf.content}\n</project_instructions>`)
				.join("\n\n");
		}

		if (skills && skills.length > 0) {
			sections.skills = formatSkillsForPrompt(skills);
		}

		if (appendedContent) {
			sections.append_prompt = appendedContent;
		}

		sections.cwd = `<cwd>\n${cwd}\n</cwd>`;

		return sections;
	};

	return defineExtension({
		name: "pi-prompt",
		sections: KEYS.map((key) => section(key, (input) => build(input)[key], { tag: false })),
	});
}
