import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineExtension, type PromptInput, section } from "@earendil-works/pi-durable";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";

export interface PromptOptions {
	systemPromptPath?: string;
	appendSystemPromptPath?: string;
}

const CONTRIBUTIONS = {
	read: {
		snippet: "Read file contents",
		guidelines: ["Use read to examine files instead of cat or sed."],
	},
	bash: {
		snippet: "Execute bash commands (ls, grep, find, etc.)",
		guidelines: [
			"Use bash for file operations like ls, rg, find",
			"You can inspect PI_* environment variables for current model and session details.",
		],
	},
	edit: {
		snippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
		guidelines: [
			"Use edit for precise changes (edits[].oldText must match exactly)",
			"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
			"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
			"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
		],
	},
	write: {
		snippet: "Create or overwrite files",
		guidelines: ["Use write only for new files or complete rewrites."],
	},
};

const KEYS = ["preamble", "tools", "rules", "docs", "addendum", "project_context", "skills", "cwd"] as const;

function loadContextFiles(cwd: string): Array<{ path: string; content: string }> {
	const files: Array<{ path: string; content: string }> = [];
	const candidates = [
		join(cwd, "AGENTS.md"),
		join(cwd, ".bb", "AGENTS.md"),
		join(cwd, ".github", "copilot-instructions.md"),
	];

	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			try {
				const content = readFileSync(candidate, "utf8").trim();
				if (content) {
					files.push({ path: candidate, content });
				}
			} catch {
				// ignore read errors
			}
		}
	}
	return files;
}

function buildRules(selectedTools: string[]): string {
	const rules: string[] = [];
	const seen = new Set<string>();
	const addRule = (rule: string): void => {
		const normalized = rule.trim();
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		rules.push(normalized);
	};

	if (selectedTools.includes("bash")) {
		addRule("Use bash for file operations like ls, rg, find");
	}

	for (const name of selectedTools) {
		const contrib = CONTRIBUTIONS[name as keyof typeof CONTRIBUTIONS];
		if (contrib) {
			for (const guideline of contrib.guidelines) {
				addRule(guideline);
			}
		}
	}

	addRule("Be concise in your responses");
	addRule("Show file paths clearly when working with files");
	return rules.map((r) => `- ${r}`).join("\n");
}

export function createPiPrompt(
	settings: SettingsManager,
	fallbackCwd: string,
	options: PromptOptions = {},
) {
	let systemPromptOverride: string | undefined;
	if (options.systemPromptPath && existsSync(options.systemPromptPath)) {
		try {
			systemPromptOverride = readFileSync(options.systemPromptPath, "utf8").trim();
		} catch (err) {
			console.error(`Warning: failed to read system-prompt: ${err}`);
		}
	}

	let appendPrompt: string | undefined;
	if (options.appendSystemPromptPath && existsSync(options.appendSystemPromptPath)) {
		try {
			appendPrompt = readFileSync(options.appendSystemPromptPath, "utf8").trim();
		} catch (err) {
			console.error(`Warning: failed to read append-system-prompt: ${err}`);
		}
	}

	const resources = new Map<string, { contextFiles: Array<{ path: string; content: string }>; skills: Skill[] }>();

	const load = (cwd: string) => {
		let found = resources.get(cwd);
		if (found === undefined) {
			found = {
				contextFiles: loadContextFiles(cwd),
				skills: [],
			};
			resources.set(cwd, found);
		}
		return found;
	};

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
		const selectedTools = input.agent.tools.map((t) => t.name);

		const sections: Record<string, string> = {};

		if (systemPromptOverride) {
			sections.preamble = systemPromptOverride;
		} else {
			sections.preamble =
				"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

			const visibleTools = selectedTools
				.filter((name) => !!CONTRIBUTIONS[name as keyof typeof CONTRIBUTIONS])
				.map((name) => `- ${name}: ${CONTRIBUTIONS[name as keyof typeof CONTRIBUTIONS].snippet}`);
			sections.tools = `<tools>\n${visibleTools.join("\n")}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.\n</tools>`;

			sections.rules = `<rules>\n${buildRules(selectedTools)}\n</rules>`;
		}

		if (appendPrompt) {
			sections.addendum = `<addendum>\n${appendPrompt}\n</addendum>`;
		}

		if (contextFiles && contextFiles.length > 0) {
			const rendered = contextFiles
				.map((cf) => `<project_instructions path="${cf.path}">\n${cf.content}\n</project_instructions>`)
				.join("\n\n");
			sections.project_context = `<project_context>\nProject-specific instructions and guidelines:\n\n${rendered}\n</project_context>`;
		}

		if (skills && skills.length > 0) {
			sections.skills = `<skills>\n${formatSkillsForPrompt(skills, "read")}\n</skills>`;
		}

		sections.cwd = `<cwd>\n${cwd.replace(/\\/g, "/")}\n</cwd>`;

		return sections;
	};

	return defineExtension({
		name: "pi-prompt",
		sections: KEYS.map((key) => section(key, (input) => build(input)[key], { tag: false })),
	});
}
