import type { Registry } from "@earendil-works/pi-durable";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { SubagentPolicyRecord } from "../../policy/types.ts";
import type { PromptOptions } from "../prompt.ts";
import type { DynamicCodemodeNamespaces } from "../codemode-namespaces.ts";

export type PluginCategory = "built-in" | "external" | "custom";

export interface DurablePluginContext {
	cwd: string;
	storageDir?: string;
	registry?: Registry;
	settingsManager?: SettingsManager;
	getSubagentPolicy?: () => SubagentPolicyRecord;
	prompt?: PromptOptions;
	dynamicNamespaces?: DynamicCodemodeNamespaces;
}

export interface DurablePlugin {
	id: string;
	name: string;
	category: PluginCategory;
	version: string;
	register(ctx: DurablePluginContext): Promise<void> | void;
	teardown?(): Promise<void> | void;
}
