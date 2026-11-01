import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import type { DurablePlugin, DurablePluginContext } from "../types.ts";

let activeSandbox: CodemodeSandbox | undefined;

export const codemodePlugin: DurablePlugin = {
	id: "codemode",
	name: "Codemode",
	category: "built-in",
	version: "1.0.0",
	register(ctx: DurablePluginContext): void {
		if (!ctx.registry) return;
		activeSandbox = new CodemodeSandbox();
		const ext = createCodemodeExtension({
			sandbox: activeSandbox,
			get namespaces() {
				return ctx.dynamicNamespaces?.getNamespaces?.() ?? [];
			},
		});
		ctx.registry.install(ext);
	},
	async teardown(): Promise<void> {
		if (activeSandbox) {
			const sb = activeSandbox as { close?: () => Promise<void>; dispose?: () => Promise<void> };
			if (typeof sb.close === "function") {
				await sb.close();
			} else if (typeof sb.dispose === "function") {
				await sb.dispose();
			}
			activeSandbox = undefined;
		}
	},
};

export default codemodePlugin;
