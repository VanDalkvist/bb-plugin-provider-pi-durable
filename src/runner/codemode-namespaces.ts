import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";

export interface ToolDefWithNamespace {
	name: string;
	namespace?: { name?: string; description?: string; instructions?: string };
}

export class DynamicCodemodeNamespaces {
	private readonly list: CodemodeNamespace[] = [];
	private readonly seen = new Set<string>();

	getNamespaces(): readonly CodemodeNamespace[] {
		return this.list;
	}

	registerNamespace(ns: CodemodeNamespace): void {
		if (this.seen.has(ns.prefix)) {
			const idx = this.list.findIndex((n) => n.prefix === ns.prefix);
			if (idx !== -1) {
				const existing = this.list[idx]!;
				this.list[idx] = {
					name: ns.name || existing.name,
					prefix: ns.prefix,
					description: ns.description ?? existing.description,
					instructions: ns.instructions ?? existing.instructions,
				};
			}
			return;
		}
		this.seen.add(ns.prefix);
		this.list.push(ns);
	}

	registerFromToolDefinitions(toolDefs: readonly ToolDefWithNamespace[]): void {
		for (const def of toolDefs) {
			const match = def.name.match(/^mcp__([a-zA-Z0-9_\-]+?)__/);
			if (match && match[1]) {
				const serverName = match[1];
				const prefix = `mcp__${serverName}__`;
				this.registerNamespace({
					name: def.namespace?.name ?? serverName,
					prefix,
					...(def.namespace?.description ? { description: def.namespace.description } : {}),
					...(def.namespace?.instructions ? { instructions: def.namespace.instructions } : {}),
				});
			} else if (def.namespace?.name) {
				const name = def.namespace.name;
				const prefix = def.name.startsWith(`${name}__`)
					? `${name}__`
					: def.name.startsWith(`${name}_`)
						? `${name}_`
						: `${name}:`;
				this.registerNamespace({
					name,
					prefix,
					...(def.namespace.description ? { description: def.namespace.description } : {}),
					...(def.namespace.instructions ? { instructions: def.namespace.instructions } : {}),
				});
			}
		}
	}
}
