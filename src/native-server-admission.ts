import { z } from "zod";
import type { BbPluginApi, ExperimentalHostClient, ExperimentalPluginProviderEnvContext, ExperimentalPluginProviderEnvEntry } from "@get-bb/plugin-sdk";
import { OrdinaryRootRouteSchema, NativeChildRouteSchema } from "./native-child-contract.ts";
import { nativeChildHostContract, NATIVE_CHILD_SOCKET_ENV, NATIVE_CHILD_CREDENTIAL_ENV, NATIVE_CHILD_ROUTE_ENV } from "./native-child-host-contract.ts";
import { NativeChildDiscoverySchema, nativeChildDiscoverySignals } from "./native-child-discovery-contract.ts";
import { NativeChildBbSync } from "./native-child-bb-sync.ts";

const bindingSchema = z.discriminatedUnion("kind", [OrdinaryRootRouteSchema, NativeChildRouteSchema]);
const rootSchema = z.object({ route: OrdinaryRootRouteSchema, durableSessionId: z.string().min(1), launch: nativeChildHostContract.prepareRoot.input.shape.launch }).strict();

export class NativeServerAdmission {
	private readonly bb: Pick<BbPluginApi, "pluginId" | "sdk" | "storage">;
	private readonly host: ExperimentalHostClient<typeof nativeChildHostContract, typeof nativeChildDiscoverySignals>;
	private readonly sync: NativeChildBbSync;
	private readonly pending = new Map<string, Promise<z.infer<typeof rootSchema>>>();
	private readonly reconciled = new Map<string, Promise<void>>();
	constructor(bb: Pick<BbPluginApi, "pluginId" | "sdk" | "storage">, host: ExperimentalHostClient<typeof nativeChildHostContract, typeof nativeChildDiscoverySignals>) {
		this.bb = bb;
		this.host = host;
		this.sync = new NativeChildBbSync(bb, host);
	}

	async discovered(payload: unknown, hostId: string): Promise<void> {
		await this.sync.observe(NativeChildDiscoverySchema.parse(payload), hostId);
	}

	async rootReady(payload: unknown, hostId: string): Promise<void> {
		const ready = nativeChildDiscoverySignals.nativeRootReady.payload.parse(payload);
		const key = JSON.stringify([ready.parentThreadId, ready.durableSessionId, ready.generation, hostId]);
		let work = this.reconciled.get(key);
		if (!work) {
			work = this.reconcileReady(ready, hostId);
			this.reconciled.set(key, work);
		}
		try { await work; } catch (error) {
			if (this.reconciled.get(key) === work) this.reconciled.delete(key);
			throw error;
		}
	}

	private async reconcileReady(ready: z.infer<typeof nativeChildDiscoverySignals.nativeRootReady.payload>, hostId: string): Promise<void> {
		const saved = rootSchema.parse(await this.bb.storage.kv.get<unknown>(`native-root:${ready.parentThreadId}`));
		const thread = await this.bb.sdk.threads.get({ threadId: ready.parentThreadId, include: "environment" });
		if (saved.route.threadId !== ready.parentThreadId || saved.durableSessionId !== ready.durableSessionId
			|| saved.route.placement.hostId !== hostId || thread.id !== ready.parentThreadId
			|| thread.environmentId !== saved.route.placement.environmentId || thread.projectId !== saved.route.placement.projectId
			|| thread.providerId !== "pi-durable" || thread.parentThreadId !== null
			|| !('environment' in thread) || thread.environment?.hostId !== hostId
			|| thread.environment?.lifecycle.phase !== "active" || thread.deletedAt !== null) throw new Error("Native Durable root ready denied");
		const status = await this.host.call("rootReadiness", { parentThreadId: ready.parentThreadId, durableSessionId: ready.durableSessionId }, { hostId });
		if (!status.ready || status.generation !== ready.generation) throw new Error("Native Durable root ready generation changed");
		const children = await this.host.call("discoverNativeChildren", ready, { hostId });
		for (const child of children) await this.sync.observe(child, hostId);
	}

	async environment(context: ExperimentalPluginProviderEnvContext): Promise<readonly ExperimentalPluginProviderEnvEntry[]> {
		const thread = await this.bb.sdk.threads.get({ threadId: context.threadId, include: "environment" });
		if (thread.id !== context.threadId || thread.projectId !== context.projectId || thread.providerId !== "pi-durable"
			|| !("environment" in thread) || !thread.environment || thread.environment.id !== thread.environmentId
			|| thread.environment.hostId !== context.hostId || thread.environment.projectId !== context.projectId || !thread.environment.path
			|| thread.deletedAt !== null || thread.environment.lifecycle.phase !== "active") throw new Error("Native Durable admission denied");
		const stored = await this.bb.storage.kv.get<unknown>(`native-view:${context.threadId}`);
		if (stored !== undefined) {
			const route = bindingSchema.parse(stored);
			const metadata = await this.bb.sdk.threads.getPluginMetadata({ threadId: thread.id, pluginId: this.bb.pluginId });
			if (!metadata.data || typeof metadata.data !== "object" || Array.isArray(metadata.data)
				|| metadata.data.nativeDurableLocator !== `${route.kind === "native-child" ? `${route.child.durableSessionId}:${route.child.conversationId}:${route.child.taskId}` : ""}`) throw new Error("Native Durable locator mismatch");
			if (route.kind !== "native-child" || route.threadId !== thread.id || route.placement.parentThreadId !== thread.parentThreadId
				|| route.placement.projectId !== thread.projectId || route.placement.environmentId !== thread.environmentId || route.placement.hostId !== context.hostId) throw new Error("Native Durable admission denied");
			const history = await this.bb.sdk.threads.events.list({ threadId: thread.id, types: ["thread/identity"], order: "desc", limit: "1" });
			const identity = history.find((event) => event.type === "thread/identity");
			if (identity?.type === "thread/identity" && identity.data.providerThreadId !== route.providerThreadId) throw new Error("Native Durable child identity changed");
			const result = await this.host.call("registerNativeChild", { route }, { hostId: context.hostId });
			return this.entries(route, result);
		}
		// Native locators never authorize an ordinary executor fallback.
		const metadata = await this.bb.sdk.threads.getPluginMetadata({ threadId: thread.id, pluginId: this.bb.pluginId });
		if (metadata.data && typeof metadata.data === "object" && !Array.isArray(metadata.data) && "nativeDurableLocator" in metadata.data) throw new Error("Native Durable binding missing");
		if (thread.originKind === "fork" || thread.sourceThreadId !== null) throw new Error("Native Durable fork/restore lacks verified native snapshot");
		let prepared = this.pending.get(thread.id);
		if (!prepared) {
			prepared = this.root(context, thread.parentThreadId, thread.environmentId!, thread.environment.path);
			this.pending.set(thread.id, prepared);
		}
		let root: z.infer<typeof rootSchema>;
		try { root = await prepared; } finally { if (this.pending.get(thread.id) === prepared) this.pending.delete(thread.id); }
		if (root.route.threadId !== thread.id || root.route.placement.hostId !== context.hostId || root.route.placement.environmentId !== thread.environmentId
			|| root.route.placement.projectId !== context.projectId || root.route.placement.parentThreadId !== thread.parentThreadId || root.launch.cwd !== thread.environment.path) throw new Error("Native Durable admission changed");
		const result = await this.host.call("prepareRoot", root, { hostId: context.hostId });
		const status = await this.host.call("rootReadiness", { parentThreadId: thread.id, durableSessionId: root.durableSessionId }, { hostId: context.hostId });
		if (status.ready) setImmediate(() => {
			void this.rootReady({ parentThreadId: thread.id, durableSessionId: root.durableSessionId, generation: status.generation }, context.hostId)
				.catch((error: unknown) => console.error("Native root restored discovery failed:", error));
		});
		return this.entries(root.route, result);
	}

	private async root(context: ExperimentalPluginProviderEnvContext, parentThreadId: string | null, environmentId: string, cwd: string): Promise<z.infer<typeof rootSchema>> {
		const previous = await this.bb.storage.kv.get<unknown>(`native-root:${context.threadId}`);
		const history = await this.bb.sdk.threads.events.list({ threadId: context.threadId, types: ["thread/identity"], order: "desc", limit: "1" });
		const identity = history.find((event) => event.type === "thread/identity");
		if (!identity && previous !== undefined) throw new Error("Native Durable root identity missing");
		if (!identity && !["pending", "starting"].includes((await this.bb.sdk.threads.get({ threadId: context.threadId })).status)) throw new Error("Native Durable existing session identity missing");
		const providerThreadId = identity?.type === "thread/identity" ? identity.data.providerThreadId : `bb_${context.threadId}`;
		if (previous !== undefined) {
			const restored = rootSchema.parse(previous);
			if (restored.route.providerThreadId !== providerThreadId) throw new Error("Native Durable root identity changed");
			return restored;
		}
		const location = await this.host.call("resolveSessionLocation", { providerThreadId }, { hostId: context.hostId });
		const root = rootSchema.parse({
			route: { kind: "ordinary-root", threadId: context.threadId, providerThreadId, placement: { parentThreadId, projectId: context.projectId, environmentId, hostId: context.hostId, providerId: "pi-durable" } },
			durableSessionId: location.durableSessionId,
			launch: { cwd, sessionDirectory: location.sessionDirectory },
		});
		await this.bb.storage.kv.set(`native-root:${context.threadId}`, root);
		return root;
	}

	private entries(route: z.infer<typeof bindingSchema>, descriptor: { endpoint: string; credential: string }): readonly ExperimentalPluginProviderEnvEntry[] {
		return [
			{ name: NATIVE_CHILD_SOCKET_ENV, value: descriptor.endpoint, reason: "Private retained Durable view transport" },
			{ name: NATIVE_CHILD_CREDENTIAL_ENV, value: descriptor.credential, reason: "Private scoped Durable view admission" },
			{ name: NATIVE_CHILD_ROUTE_ENV, value: JSON.stringify(route), reason: "Verified Durable view locator" },
		];
	}
}
