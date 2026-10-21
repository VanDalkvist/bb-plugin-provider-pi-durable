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
			if (ns.description) {
				const idx = this.list.findIndex((n) => n.prefix === ns.prefix);
				if (idx !== -1) this.list[idx] = ns;
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
				const desc = def.namespace?.description ?? def.namespace?.instructions;
				this.registerNamespace({
					name: def.namespace?.name ?? serverName,
					prefix,
					...(desc ? { description: desc } : {}),
				});
			}
		}
	}
}
