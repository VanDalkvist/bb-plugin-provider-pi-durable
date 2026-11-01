export type PluginCategory = "built-in" | "external";

export interface DurablePluginContext {
	cwd: string;
	storageDir?: string;
	registry?: any;
	[key: string]: any;
}

export interface DurablePlugin {
	id: string;
	name: string;
	category: PluginCategory;
	version: string;
	register(ctx: DurablePluginContext): Promise<void> | void;
	teardown?(): Promise<void> | void;
}
