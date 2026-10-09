import type { BbPluginApi, ExperimentalHostClient } from "@get-bb/plugin-sdk";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { NativeChildRouteSchema, type NativeChildRoute } from "./native-child-contract.ts";
import { NativeChildDiscoverySchema, type NativeChildDiscovery, nativeChildDiscoverySignals } from "./native-child-discovery-contract.ts";
import { nativeChildHostContract } from "./native-child-host-contract.ts";

const PROVIDER = "pi-durable";
const locator = (value: NativeChildDiscovery) => `${value.durableSessionId}:${value.childConversationId}:${value.taskId}`;
const ledgerKey = (value: NativeChildDiscovery) => `native-binding:${value.parentThreadId}:${locator(value)}`;
const marker = (value: NativeChildDiscovery) => ({ nativeDurableLocator: locator(value) });

type Binding = { locator: string; threadId: string; phase: "intent" | "submitted" };

/** A server-only synchronizer: a native task is never created, submitted or resumed here. */
export class NativeChildBbSync {
	private readonly pending = new Map<string, Promise<void>>();
	private readonly bb: Pick<BbPluginApi, "pluginId" | "sdk" | "storage">;
	private readonly host: ExperimentalHostClient<typeof nativeChildHostContract, typeof nativeChildDiscoverySignals>;
	constructor(bb: Pick<BbPluginApi, "pluginId" | "sdk" | "storage">,
		host: ExperimentalHostClient<typeof nativeChildHostContract, typeof nativeChildDiscoverySignals>) {
		this.bb = bb;
		this.host = host;
	}

	async observe(raw: NativeChildDiscovery, hostId: string): Promise<void> {
		const signal = NativeChildDiscoverySchema.parse(raw);
		const key = ledgerKey(signal);
		const previous = this.pending.get(key) ?? Promise.resolve();
		const next = previous.catch(() => {}).then(() => this.bind(signal, hostId));
		this.pending.set(key, next);
		try { await next; } finally { if (this.pending.get(key) === next) this.pending.delete(key); }
	}

	private async bind(signal: NativeChildDiscovery, hostId: string): Promise<void> {
		const root = await this.bb.storage.kv.get<unknown>(`native-root:${signal.parentThreadId}`);
		if (!root || typeof root !== "object" || !("route" in root) || !("durableSessionId" in root)) throw new Error("Native parent not admitted");
		const parentRoute = (root as { route: { threadId: string; placement: { hostId: string; projectId: string; environmentId: string } }; durableSessionId: string }).route;
		if (parentRoute.threadId !== signal.parentThreadId || (root as { durableSessionId: string }).durableSessionId !== signal.durableSessionId
			|| parentRoute.placement.hostId !== hostId || signal.parentConversationId !== ROOT_CONVERSATION_ID) throw new Error("Native parent mismatch");
		const parent = await this.bb.sdk.threads.get({ threadId: signal.parentThreadId, include: "environment" });
		if (parent.deletedAt !== null || parent.providerId !== PROVIDER || parent.projectId !== parentRoute.placement.projectId
			|| parent.environmentId !== parentRoute.placement.environmentId || !parent.environmentId
			|| !("environment" in parent) || !parent.environment || parent.environment.hostId !== hostId
			|| parent.environment.lifecycle.phase !== "active") throw new Error("Native parent placement changed");
		const proof = await this.host.call("inspectNativeChildIntent", {
			parentThreadId: signal.parentThreadId, durableSessionId: signal.durableSessionId,
			childConversationId: signal.childConversationId, taskId: signal.taskId,
		}, { hostId });
		if (proof.requestId !== signal.requestId || proof.parentConversationId !== signal.parentConversationId
			|| proof.childConversationId !== signal.childConversationId || proof.taskId !== signal.taskId) throw new Error("Native intent mismatch");

		let binding = await this.bb.storage.kv.get<Binding>(ledgerKey(signal));
		if (!binding) {
			// A crash between spawn and ledger write is recovered from the plugin-owned locator,
			// but the locator alone cannot authorize registration: native proof is checked above.
			const matches = [];
			for (let offset = 0; ; offset += 100) {
				if (offset >= 1000) throw new Error("Native binding scan limit reached");
				const rows = await this.bb.sdk.threads.list({ parentThreadId: parent.id, projectId: parent.projectId, includeHidden: true, limit: 100, offset });
				for (const row of rows) {
					if (row.originPluginId !== this.bb.pluginId || row.providerId !== PROVIDER) continue;
					const meta = await this.bb.sdk.threads.getPluginMetadata({ threadId: row.id, pluginId: this.bb.pluginId });
					if (meta.data && typeof meta.data === "object" && !Array.isArray(meta.data)
						&& meta.data.nativeDurableLocator === locator(signal)) matches.push(row);
				}
				if (rows.length < 100) break;
			}
			if (matches.length > 1) throw new Error("Duplicate native BB slots");
			const thread = matches[0] ?? await this.bb.sdk.threads.spawn({
				projectId: parent.projectId, parentThreadId: parent.id, environment: { type: "reuse", environmentId: parent.environmentId },
				providerId: PROVIDER, input: [], visibility: "visible", title: `Native subagent ${signal.taskId}`,
				pluginMetadata: marker(signal),
			});
			binding = { locator: locator(signal), threadId: thread.id, phase: "intent" };
			await this.bb.storage.kv.set(ledgerKey(signal), binding);
		}
		if (binding.locator !== locator(signal)) throw new Error("Native binding mismatch");
		const child = await this.bb.sdk.threads.get({ threadId: binding.threadId, include: "environment" });
		if (child.deletedAt !== null || child.providerId !== PROVIDER || child.projectId !== parent.projectId
			|| child.parentThreadId !== parent.id || child.environmentId !== parent.environmentId
			|| child.originPluginId !== this.bb.pluginId || child.visibility !== "visible"
			|| !("environment" in child) || !child.environment || child.environment.hostId !== hostId) throw new Error("Native slot placement changed");
		const meta = await this.bb.sdk.threads.getPluginMetadata({ threadId: child.id, pluginId: this.bb.pluginId });
		if (!meta.data || typeof meta.data !== "object" || Array.isArray(meta.data)
			|| meta.data.nativeDurableLocator !== locator(signal)) throw new Error("Native slot locator changed");
		if (signal.phase !== "submitted" || binding.phase === "submitted") return;
		const identities = await this.bb.sdk.threads.events.list({ threadId: child.id, types: ["thread/identity"], order: "desc", limit: "1" });
		const identity = identities.find((event) => event.type === "thread/identity");
		const route: NativeChildRoute = NativeChildRouteSchema.parse({
			kind: "native-child", threadId: child.id,
			providerThreadId: identity?.type === "thread/identity" ? identity.data.providerThreadId : `bb_${child.id}`,
			placement: { parentThreadId: parent.id, projectId: parent.projectId, environmentId: parent.environmentId,
				hostId, providerId: PROVIDER },
			child: { durableSessionId: signal.durableSessionId, taskId: signal.taskId,
				conversationId: signal.childConversationId, requestId: signal.requestId }, bootstrapRequestId: signal.requestId,
		});
		// Host registration verifies the actual native input submission before a grant
		// or private KV association can exist. Credentials never enter KV/metadata.
		await this.host.call("registerNativeChild", { route }, { hostId });
		await this.bb.storage.kv.set(`native-view:${child.id}`, route);
		await this.bb.storage.kv.set(ledgerKey(signal), { ...binding, phase: "submitted" });
	}
}
