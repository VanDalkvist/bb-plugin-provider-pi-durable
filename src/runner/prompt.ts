import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { defineExtension, type PromptInput, section } from "@earendil-works/pi-durable";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	formatSkillsForPrompt,
	type SettingsManager,
	type Skill,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

export interface ResourceLoaderLike {
	getAgentsFiles?: ResourceLoader["getAgentsFiles"];
	getSkills?: ResourceLoader["getSkills"];
}

export interface PromptOptions {
	systemPromptPath?: string;
	/** The upstream CLI accepts literal text or a file locator under this flag. */
	appendSystemPromptPath?: string;
	readAppendPrompt?: (value: string, cwd: string) => string;
	contextFiles?: Array<{ path: string; content: string }>;
	resourceLoader?: ResourceLoaderLike;
}

function canonicalToolDefinitions(cwd: string) {
	return {
		read: createReadToolDefinition(cwd),
		write: createWriteToolDefinition(cwd),
		edit: createEditToolDefinition(cwd),
		bash: createBashToolDefinition(cwd),
	};
}

const KEYS = ["preamble", "tools", "rules", "docs", "addendum", "project_context", "skills", "cwd"] as const;

function resolveContextFiles(options: PromptOptions): Array<{ path: string; content: string }> {
	if (options.contextFiles && options.contextFiles.length > 0) {
		return options.contextFiles;
	}
	if (options.resourceLoader?.getAgentsFiles) {
		return options.resourceLoader.getAgentsFiles()?.agentsFiles ?? [];
	}
	return [];
}

function resolveSkills(options: PromptOptions): Skill[] {
	if (options.resourceLoader?.getSkills) {
		return options.resourceLoader.getSkills().skills;
	}
	return [];
}

function buildRules(selectedTools: string[], defs: ReturnType<typeof canonicalToolDefinitions>): string {
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
		const def = defs[name as keyof typeof defs];
		if (def?.promptGuidelines) {
			for (const guideline of def.promptGuidelines) {
				addRule(guideline);
			}
		}
	}

	addRule("Be concise in your responses");
	addRule("Show file paths clearly when working with files");
	return rules.map((r) => `- ${r}`).join("\n");
}

function tryReadPromptFile(path?: string, label?: string): string | undefined {
	if (!path || !existsSync(path)) return undefined;
	try {
		return readFileSync(path, "utf8").trim();
	} catch (err) {
		console.error(`Warning: failed to read ${label ?? "prompt"}: ${err}`);
		return undefined;
	}
}

export function resolveAppendPrompt(value: string, cwd: string): string {
	const file = resolve(cwd, value);
	// Explicit locators must not silently turn into instructions if unreadable or absent.
	const explicitPath = isAbsolute(value) || /^\.{1,2}[\\/]/u.test(value);
	if (!explicitPath && !existsSync(file)) return value;
	return readFileSync(file, "utf8").trim();
}

export function createPiPrompt(
	_settings: SettingsManager,
	fallbackCwd: string,
	options: PromptOptions = {},
) {
	const systemPromptOverride = tryReadPromptFile(options.systemPromptPath, "system-prompt");
	const appendPrompt = options.appendSystemPromptPath === undefined ? undefined
		: (options.readAppendPrompt ?? resolveAppendPrompt)(options.appendSystemPromptPath, fallbackCwd);

	const buildSections = (input: PromptInput): Record<string, string> => {
		const cwd = input.env?.cwd ?? input.agent.cwd ?? fallbackCwd;
		const contextFiles = resolveContextFiles(options);
		const skills = resolveSkills(options);
		const selectedTools = input.agent.tools.map((t) => t.name);
		const toolDefs = canonicalToolDefinitions(cwd);

		const sections: Record<string, string> = {};

		if (systemPromptOverride) {
			sections.preamble = systemPromptOverride;
		} else {
			sections.preamble =
				"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

			const visibleTools = selectedTools
				.filter((name) => name in toolDefs)
				.map((name) => `- ${name}: ${toolDefs[name as keyof typeof toolDefs].promptSnippet}`);
			sections.tools = `<tools>\n${visibleTools.join("\n")}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.\n</tools>`;

			sections.rules = `<rules>\n${buildRules(selectedTools, toolDefs)}\n</rules>`;
		}

		if (appendPrompt) {
			sections.addendum = `<addendum>\n${appendPrompt}\n</addendum>`;
		}

		if (contextFiles.length > 0) {
			const rendered = contextFiles
				.map((cf) => `<project_instructions path="${cf.path}">\n${cf.content}\n</project_instructions>`)
				.join("\n\n");
			sections.project_context = `<project_context>\nProject-specific instructions and guidelines:\n\n${rendered}\n</project_context>`;
		}

		if (skills.length > 0) {
			sections.skills = `<skills>\n${formatSkillsForPrompt(skills, "read")}\n</skills>`;
		}

		sections.cwd = `<cwd>\n${cwd.replace(/\\/g, "/")}\n</cwd>`;
		return sections;
	};

	const built = new WeakMap<PromptInput, Record<string, string>>();
	const getOrBuild = (input: PromptInput): Record<string, string> => {
		let sections = built.get(input);
		if (sections === undefined) {
			sections = buildSections(input);
			built.set(input, sections);
		}
		return sections;
	};

	return defineExtension({
		name: "pi-prompt",
		sections: KEYS.map((key) => section(key, (input) => getOrBuild(input)[key], { tag: false })),
	});
}
