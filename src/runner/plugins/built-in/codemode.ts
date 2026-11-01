import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import type { DurablePlugin, DurablePluginContext } from "../types.ts";

export const codemodePlugin: DurablePlugin = {
	id: "codemode",
	name: "Codemode",
	category: "built-in",
	version: "1.0.0",
	register(ctx: DurablePluginContext): void {
		if (!ctx.registry) return;
		const ext = createCodemodeExtension({
			sandbox: new CodemodeSandbox(),
			get namespaces() {
				return ctx.dynamicNamespaces?.getNamespaces?.() ?? [];
			},
		});
		ctx.registry.install(ext);
	},
};

export default codemodePlugin;
