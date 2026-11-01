import { DurablePluginError } from "../errors.ts";
import type { DurablePlugin, DurablePluginContext, PluginCategory } from "./types.ts";

export class DurablePluginRegistry {
	readonly #plugins = new Map<string, DurablePlugin>();

	register(plugin: DurablePlugin): void {
		if (this.#plugins.has(plugin.id)) {
			throw new DurablePluginError(
				plugin.id,
				`Plugin with id '${plugin.id}' is already registered`,
			);
		}
		this.#plugins.set(plugin.id, plugin);
	}

	get(id: string): DurablePlugin | undefined {
		return this.#plugins.get(id);
	}

	list(category?: PluginCategory): DurablePlugin[] {
		const all = Array.from(this.#plugins.values());
		if (!category) return all;
		return all.filter((p) => p.category === category);
	}

	async initAll(ctx: DurablePluginContext): Promise<void> {
		for (const plugin of this.#plugins.values()) {
			try {
				await plugin.register(ctx);
			} catch (err) {
				if (err instanceof DurablePluginError) {
					throw err;
				}
				throw new DurablePluginError(
					plugin.id,
					`Failed to initialize plugin '${plugin.id}': ${err instanceof Error ? err.message : String(err)}`,
					err,
				);
			}
		}
	}

	async teardownAll(): Promise<void> {
		const plugins = Array.from(this.#plugins.values()).reverse();
		for (const plugin of plugins) {
			if (typeof plugin.teardown === "function") {
				try {
					await plugin.teardown();
				} catch {
					// Gracefully proceed with other teardowns
				}
			}
		}
	}
}
