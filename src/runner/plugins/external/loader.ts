import { existsSync, promises as fs } from "node:fs";
import { join } from "node:path";
import type { DurablePlugin } from "../types.ts";

interface PluginManifest {
	id?: string;
	name?: string;
	version?: string;
	main?: string;
	[key: string]: unknown;
}

function parseManifest(raw: string): PluginManifest | null {
	try {
		const parsed = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null ? (parsed as PluginManifest) : null;
	} catch {
		return null;
	}
}

async function resolvePluginModule(dir: string, manifest: PluginManifest): Promise<Partial<DurablePlugin>> {
	const candidates = [
		manifest.main ? join(dir, manifest.main) : undefined,
		join(dir, "index.js"),
		join(dir, "index.mjs"),
		join(dir, "index.ts"),
	].filter((c): c is string => Boolean(c && existsSync(c)));

	if (candidates.length === 0) return {};

	try {
		const mod = await import(candidates[0]);
		return {
			register: typeof mod.register === "function" ? mod.register : mod.default?.register,
			teardown: typeof mod.teardown === "function" ? mod.teardown : mod.default?.teardown,
		};
	} catch {
		return {};
	}
}

export async function loadExternalPlugins(pluginsDir: string): Promise<DurablePlugin[]> {
	if (!existsSync(pluginsDir)) return [];

	const entries = await fs.readdir(pluginsDir, { withFileTypes: true });
	const plugins: DurablePlugin[] = [];

	for (const entry of entries) {
		const entryPath = join(pluginsDir, entry.name);

		if (entry.isDirectory()) {
			const manifestPath = join(entryPath, "plugin.json");
			if (!existsSync(manifestPath)) continue;

			const content = await fs.readFile(manifestPath, "utf8");
			const manifest = parseManifest(content);
			if (!manifest?.id) continue;

			const mod = await resolvePluginModule(entryPath, manifest);
			plugins.push({
				id: manifest.id,
				name: manifest.name ?? manifest.id,
				category: "external",
				version: manifest.version ?? "1.0.0",
				register: mod.register ?? (() => {}),
				teardown: mod.teardown,
			});
		} else if (entry.isFile() && entry.name.endsWith(".json")) {
			const content = await fs.readFile(entryPath, "utf8");
			const manifest = parseManifest(content);
			if (!manifest?.id) continue;

			plugins.push({
				id: manifest.id,
				name: manifest.name ?? manifest.id,
				category: "external",
				version: manifest.version ?? "1.0.0",
				register: () => {},
			});
		}
	}

	return plugins;
}
