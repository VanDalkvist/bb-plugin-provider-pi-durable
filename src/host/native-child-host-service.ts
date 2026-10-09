import { randomUUID } from "node:crypto";
import { resolveSessionFilePath } from "./paths.ts";
import { basename, isAbsolute, join, resolve } from "node:path";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type { ExperimentalHostRpcContext, ExperimentalHostWorkerLease } from "@get-bb/plugin-sdk/host";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { NativeChildAuthority } from "./native-child-authority.ts";
import { SharedOwnerRegistry, type ConversationViewLease, type DurableOwnerIdentity } from "./shared-owner.ts";
import { RunnerProcessDriver, type RunnerProcessFactory } from "./shared-runner.ts";
import { NativeChildTransportServerAdapter, type NativeChildTransportOptions, type NativeChildTransportRequest } from "./native-child-transport.ts";
import { NativeChildIntentHostRequestSchema, NativeRootConfigureSchema, NATIVE_CHILD_CREDENTIAL_ENV, NATIVE_CHILD_ROUTE_ENV, NATIVE_CHILD_SOCKET_ENV, type NativeChildIntentHostRequest, type NativeChildLaunchConfig, type NativeRootConfigure } from "../native-child-host-contract.ts";
import { createNativeRootLaunchAttestor, type NativeRootLaunchAttestor } from "./native-root-launch-attestor.ts";
import { NativeChildIntentProofSchema } from "../runner/native-child-inspection.ts";
import { NativeChildDiscoverySchema, type NativeChildDiscovery, nativeChildDiscoverySignals } from "../native-child-discovery-contract.ts";
import { NativeChildRouteSchema, OrdinaryRootRouteSchema, NativeChildViewEventSchema } from "../native-child-contract.ts";
import type { NativeChildRoute, OrdinaryRootRoute, RegisteredRoute } from "../native-child-contract.ts";
import { z } from "zod";

type HostContext = Pick<ExperimentalHostRpcContext<typeof nativeChildDiscoverySignals>, "signal" | "lifecycle" | "experimental_paths" | "experimental_retainWorker" | "experimental_emitSignal">;
type NativeChildHostDependencies = {
	createRunner?: RunnerProcessFactory;
	transport?: Omit<NativeChildTransportOptions, "endpoint" | "handle" | "attachView">;
	attestLaunch?: NativeRootLaunchAttestor;
	validatePromptPath?: (path: string) => Promise<void>;
	pendingTimeoutMs?: number;
};
type NativeHostDescriptor = { endpoint: string; credential: string; generation: number };
type OwnerLaunch = NativeChildLaunchConfig & { durableSessionId: string };
type IssuedGrant = { route: RegisteredRoute; identity: DurableOwnerIdentity; generation: number };

const DENIED = "Native child host operation denied";

export class NativeChildHostService {
	private readonly endpoint: string;
	private readonly authority = new NativeChildAuthority();
	private readonly launches = new Map<string, OwnerLaunch>();
	private readonly staged = new Map<string, { route: OrdinaryRootRoute; cwd: string; sessionDirectory: string; retention: ExperimentalHostWorkerLease; timer: ReturnType<typeof setTimeout>; pending: number }>();
	private readonly configuring = new Map<string, Promise<{ accepted: true; generation: number }>>();
	private readonly attestLaunch: NativeRootLaunchAttestor;
	private readonly validatePromptPath: (path: string) => Promise<void>;
	private readonly pendingTimeoutMs: number;
	private readonly workerContexts = new Map<string, HostContext>();
	private readonly stageContext = new Map<string, HostContext>();
	private readonly lifecycleSignals = new Set<AbortSignal>();
	private readonly rootSessionByThread = new Map<string, string>();
	private readonly grants = new Map<string, IssuedGrant>();
	private readonly ownerPreparations = new Map<string, Promise<ConversationViewLease>>();
	private readonly discoveryListeners = new Map<string, { generation: number; unsubscribe: () => void }>();
	private readonly driver: RunnerProcessDriver;
	private readonly owners: SharedOwnerRegistry;
	private readonly transport: NativeChildTransportServerAdapter;
	private disposed = false;
	private disposePromise?: Promise<void>;

	constructor(paths: HostContext["experimental_paths"], dependencies: NativeChildHostDependencies = {}) {
		this.endpoint = join(resolve(paths.tempDir), "native-child-host.sock");
		this.attestLaunch = dependencies.attestLaunch ?? createNativeRootLaunchAttestor(paths.dataDir);
		this.validatePromptPath = dependencies.validatePromptPath ?? ((path) => access(path, constants.R_OK));
		this.pendingTimeoutMs = dependencies.pendingTimeoutMs ?? 5 * 60 * 1000;
		this.driver = new RunnerProcessDriver((identity) => {
			const launch = this.launches.get(identity.durableSessionId);
			if (!launch || launch.durableSessionId !== identity.durableSessionId) throw new Error(DENIED);
			return {
				cwd: launch.cwd,
				args: ["--cwd", launch.cwd, "--session", launch.sessionDirectory,
					...(launch.model ? ["--provider", launch.model.provider, "--model", launch.model.modelId] : []),
					...(launch.thinking ? ["--thinking", launch.thinking] : []),
					...(launch.appendSystemPrompt ? ["--append-system-prompt", launch.appendSystemPrompt] : [])],
				env: { ...launch.environment, BB_PI_DURABLE_PARENT_THREAD_ID: this.rootRoutes.get(identity.durableSessionId)?.threadId ?? "" },
			};
		}, dependencies.createRunner);
		this.owners = new SharedOwnerRegistry({
			authority: this.authority,
			driver: this.driver,
			retain: (identity) => {
				const context = this.workerContexts.get(identity.durableSessionId);
				if (!context) throw new Error(DENIED);
				const lease = context.experimental_retainWorker();
				return { release: () => lease.dispose() };
			},
			validateChildTask: async (route, identity) => this.verifyNativeChild(route, identity),
		});
		this.transport = new NativeChildTransportServerAdapter({
			...dependencies.transport,
			endpoint: this.endpoint,
			handle: (request) => this.handleTransportRequest(request),
			attachView: (request, emit, signal) => this.attachView(request, emit, signal),
		});
	}

	async prepareRoot(input: { route: OrdinaryRootRoute; durableSessionId: string; launch: Pick<NativeChildLaunchConfig, "cwd" | "sessionDirectory"> }, context: HostContext): Promise<{ endpoint: string; credential: string; generation: 0; phase: "pending" }> {
		this.assertActive(context);
		const route = OrdinaryRootRouteSchema.parse(input.route);
		const sessionDirectory = resolve(input.launch.sessionDirectory);
		if (!isAbsolute(input.launch.sessionDirectory) || input.launch.sessionDirectory.split(/[\\/]/u).includes("..")
			|| sessionDirectory !== input.launch.sessionDirectory || basename(sessionDirectory) !== input.durableSessionId
			|| !isAbsolute(input.launch.cwd) || resolve(input.launch.cwd) !== input.launch.cwd
			|| input.launch.cwd.split(/[\\/]/u).includes("..")) throw new Error(DENIED);
		const previousRoute = this.rootRoutes.get(input.durableSessionId);
		const previousStage = this.staged.get(input.durableSessionId);
		const previousLaunch = this.launches.get(input.durableSessionId);
		if ((previousRoute && JSON.stringify(previousRoute) !== JSON.stringify(route))
			|| (previousStage && (previousStage.cwd !== input.launch.cwd || previousStage.sessionDirectory !== sessionDirectory))
			|| (previousLaunch && (previousLaunch.cwd !== input.launch.cwd || previousLaunch.sessionDirectory !== sessionDirectory))
			|| (this.rootSessionByThread.has(route.threadId) && this.rootSessionByThread.get(route.threadId) !== input.durableSessionId)) throw new Error(DENIED);
		const readyExisting = previousLaunch && this.owners.lifecycle({ durableSessionId: input.durableSessionId, conversationId: ROOT_CONVERSATION_ID })?.kind === "ready";
		this.takeWorkerLease(context);
		if (!readyExisting) this.stageContext.set(input.durableSessionId, context);
		let stage = previousStage;
		if (!stage && !readyExisting) {
			this.authority.registerRoot(route);
			const timer = setTimeout(() => this.expireStaged(input.durableSessionId), this.pendingTimeoutMs);
			timer.unref();
			stage = { route: structuredClone(route), cwd: input.launch.cwd, sessionDirectory, retention: context.experimental_retainWorker(), timer, pending: 0 };
			this.staged.set(input.durableSessionId, stage);
			this.rootRoutes.set(input.durableSessionId, structuredClone(route));
			this.rootSessionByThread.set(route.threadId, input.durableSessionId);
		}
		if (stage) stage.pending++;
		try {
			await this.transport.start();
			this.assertActive(context);
			if (!readyExisting && this.staged.get(input.durableSessionId) !== stage) throw new Error(DENIED);
			const identity: DurableOwnerIdentity = { durableSessionId: input.durableSessionId, conversationId: ROOT_CONVERSATION_ID };
			const currentGeneration = readyExisting ? this.owners.lifecycle(identity)?.generation : 0;
			let credential: string | undefined;
			for (const [candidate, grant] of this.grants) {
				if (grant.identity.durableSessionId !== input.durableSessionId || grant.generation !== currentGeneration
					|| JSON.stringify(grant.route) !== JSON.stringify(route)) continue;
				try { this.authority.redeem({ credential: candidate, expected: route }); credential = candidate; break; } catch { continue; }
			}
			if (!credential) {
				credential = this.authority.issue(route).credential;
				this.grants.set(credential, { route: structuredClone(route), identity, generation: currentGeneration ?? 0 });
			}
			return { endpoint: this.endpoint, credential, generation: 0, phase: "pending" };
		} finally {
			if (stage) {
				stage.pending--;
				if (this.staged.get(input.durableSessionId) === stage && stage.pending === 0
					&& !Array.from(this.grants.values()).some((grant) => grant.identity.durableSessionId === input.durableSessionId && grant.route.kind === "ordinary-root")) {
					this.expireStaged(input.durableSessionId);
				}
			}
		}
	}

	private expireStaged(durableSessionId: string): void {
		const stage = this.staged.get(durableSessionId);
		if (!stage || this.configuring.has(durableSessionId)) return;
		clearTimeout(stage.timer);
		this.staged.delete(durableSessionId);
		this.stageContext.delete(durableSessionId);
		this.rootRoutes.delete(durableSessionId);
		this.rootSessionByThread.delete(stage.route.threadId);
		for (const [credential, grant] of this.grants) {
			if (grant.identity.durableSessionId === durableSessionId && grant.route.kind === "ordinary-root") {
				this.authority.revokeCredential(credential);
				this.grants.delete(credential);
			}
		}
		void stage.retention.dispose().catch((error: unknown) => console.error("Native root pending retention release failed:", error));
	}

	private async configureRoot(grant: IssuedGrant, proposed: NativeRootConfigure): Promise<{ accepted: true; generation: number }> {
		if (grant.route.kind !== "ordinary-root" || this.disposed) throw new Error(DENIED);
		const identity = grant.identity;
		const stage = this.staged.get(identity.durableSessionId);
		if (stage && (stage.route.threadId !== grant.route.threadId || JSON.stringify(stage.route) !== JSON.stringify(grant.route))) throw new Error(DENIED);
		const parsed = NativeRootConfigureSchema.parse(proposed);
		if (parsed.cwd !== (stage?.cwd ?? this.launches.get(identity.durableSessionId)?.cwd) || !isAbsolute(parsed.cwd) || resolve(parsed.cwd) !== parsed.cwd || parsed.cwd.split(/[\\/]/u).includes("..")) throw new Error(DENIED);
		const environment = Object.fromEntries(Object.entries(parsed.environment).filter(([key]) =>
			!([NATIVE_CHILD_CREDENTIAL_ENV, NATIVE_CHILD_SOCKET_ENV, NATIVE_CHILD_ROUTE_ENV, "BB_PI_DURABLE_PARENT_THREAD_ID"] as string[]).includes(key)));
		const launch: OwnerLaunch = { cwd: parsed.cwd, sessionDirectory: stage?.sessionDirectory ?? this.launches.get(identity.durableSessionId)?.sessionDirectory ?? "",
			model: parsed.model, thinking: parsed.thinking, ...(parsed.appendSystemPrompt ? { appendSystemPrompt: parsed.appendSystemPrompt } : {}),
			environment, durableSessionId: identity.durableSessionId };
		const existing = this.launches.get(identity.durableSessionId);
		if (existing && JSON.stringify(existing) !== JSON.stringify(launch)) throw new Error(DENIED);
		if (!stage) {
			const current = this.owners.lifecycle(identity);
			if (!existing || current?.kind !== "ready" || (grant.generation !== 0 && grant.generation !== current.generation)) throw new Error(DENIED);
			grant.generation = current.generation;
			return { accepted: true, generation: current.generation };
		}
		if (!existing) this.launches.set(identity.durableSessionId, launch);
		const inFlight = this.configuring.get(identity.durableSessionId);
		if (inFlight) return inFlight;
		const work = (async () => {
			if (launch.appendSystemPrompt && (isAbsolute(launch.appendSystemPrompt) || /^\.{1,2}[\\/]/u.test(launch.appendSystemPrompt))) {
				await this.validatePromptPath(resolve(launch.cwd, launch.appendSystemPrompt));
			}
			if (this.disposed || !this.staged.has(identity.durableSessionId)) throw new Error(DENIED);
			await this.attestLaunch(identity.durableSessionId, launch);
			if (this.disposed || !this.staged.has(identity.durableSessionId)) throw new Error(DENIED);
			const context = this.stageContext.get(identity.durableSessionId);
			if (!context) throw new Error(DENIED);
			this.workerContexts.set(identity.durableSessionId, context);
			const view = await this.prepareOwner(identity, stage.route);
			try {
				if (this.disposed) throw new Error(DENIED);
				const generation = view.identity.generation;
				this.assertGrantActive(identity, generation, generation);
				this.subscribeDiscovery(identity, stage.route, generation, context);
				for (const active of this.grants.values()) {
					if (active.identity.durableSessionId === identity.durableSessionId && active.route.kind === "ordinary-root" && active.generation === 0) active.generation = generation;
				}
				clearTimeout(stage.timer);
				this.staged.delete(identity.durableSessionId);
				void stage.retention.dispose().catch((error: unknown) => console.error("Native root staging retention release failed:", error));
				void context.experimental_emitSignal("nativeRootReady", { parentThreadId: stage.route.threadId, durableSessionId: identity.durableSessionId, generation })
					.catch((error: unknown) => console.error("Native root ready signal delivery failed:", error));
				return { accepted: true as const, generation };
			} finally { view.release(); }
		})();
		this.configuring.set(identity.durableSessionId, work);
		try { return await work; } finally {
			if (this.configuring.get(identity.durableSessionId) === work) this.configuring.delete(identity.durableSessionId);
			if (this.staged.has(identity.durableSessionId) && !this.disposed) this.expireStaged(identity.durableSessionId);
		}
	}

	async inspectNativeChildIntent(input: NativeChildIntentHostRequest, context: HostContext): Promise<z.infer<typeof NativeChildIntentProofSchema>> {
		this.assertActive(context);
		const request = NativeChildIntentHostRequestSchema.parse(input);
		const identity: DurableOwnerIdentity = { durableSessionId: request.durableSessionId, conversationId: ROOT_CONVERSATION_ID };
		const root = this.rootRoutes.get(request.durableSessionId);
		const lifecycle = this.owners.lifecycle(identity);
		if (!root || root.threadId !== request.parentThreadId || lifecycle?.kind !== "ready") throw new Error(DENIED);
		const generation = lifecycle.generation;
		const result = await this.driver.request(identity, generation, {
			type: "native-child-intent", durableSessionId: request.durableSessionId,
			parentConversationId: ROOT_CONVERSATION_ID, childConversationId: request.childConversationId, taskId: request.taskId,
		});
		this.assertActive(context);
		this.assertGrantActive(identity, generation, generation);
		const proof = NativeChildIntentProofSchema.safeParse(result);
		if (!proof.success || proof.data.durableSessionId !== request.durableSessionId
			|| proof.data.parentConversationId !== ROOT_CONVERSATION_ID
			|| proof.data.childConversationId !== request.childConversationId || proof.data.taskId !== request.taskId) throw new Error(DENIED);
		return proof.data;
	}

	rootReadiness(input: { parentThreadId: string; durableSessionId: string }, context: HostContext): { ready: boolean; generation: number } {
		this.assertActive(context);
		const root = this.rootRoutes.get(input.durableSessionId);
		if (!root || root.threadId !== input.parentThreadId) throw new Error(DENIED);
		const lifecycle = this.owners.lifecycle({ durableSessionId: input.durableSessionId, conversationId: ROOT_CONVERSATION_ID });
		return lifecycle?.kind === "ready" ? { ready: true, generation: lifecycle.generation } : { ready: false, generation: 0 };
	}

	async discoverNativeChildren(input: { parentThreadId: string; durableSessionId: string; generation: number }, context: HostContext): Promise<NativeChildDiscovery[]> {
		this.assertActive(context);
		const root = this.rootRoutes.get(input.durableSessionId);
		const identity: DurableOwnerIdentity = { durableSessionId: input.durableSessionId, conversationId: ROOT_CONVERSATION_ID };
		const lifecycle = this.owners.lifecycle(identity);
		if (!root || root.threadId !== input.parentThreadId || lifecycle?.kind !== "ready" || lifecycle.generation !== input.generation) throw new Error(DENIED);
		const generation = lifecycle.generation;
		const response = await this.driver.request(identity, generation, {
			type: "native-child-discover", durableSessionId: input.durableSessionId, parentConversationId: ROOT_CONVERSATION_ID,
		});
		this.assertActive(context);
		this.assertGrantActive(identity, generation, generation);
		const values = z.array(NativeChildDiscoverySchema).safeParse(response);
		if (!values.success || values.data.some((item) => item.parentThreadId !== root.threadId || item.durableSessionId !== input.durableSessionId || item.parentConversationId !== ROOT_CONVERSATION_ID)) throw new Error(DENIED);
		return values.data;
	}

	private subscribeDiscovery(identity: DurableOwnerIdentity, route: OrdinaryRootRoute, generation: number, context: HostContext): void {
		const previous = this.discoveryListeners.get(identity.durableSessionId);
		if (previous?.generation === generation) return;
		previous?.unsubscribe();
		const unsubscribe = this.driver.subscribeRootEvents(identity, generation, (event) => {
			if (typeof event !== "object" || event === null || !("type" in event) || event.type !== "native-child-discovered") return;
			const parsed = NativeChildDiscoverySchema.safeParse("discovery" in event ? event.discovery : undefined);
			if (!parsed.success || parsed.data.parentThreadId !== route.threadId || parsed.data.durableSessionId !== identity.durableSessionId
				|| parsed.data.parentConversationId !== ROOT_CONVERSATION_ID || this.owners.lifecycle(identity)?.generation !== generation) return;
			void context.experimental_emitSignal("nativeChildDiscovered", parsed.data).catch((error: unknown) => {
				console.error("Native child discovery signal delivery failed:", error);
			});
		});
		this.discoveryListeners.set(identity.durableSessionId, { generation, unsubscribe });
	}

	async registerNativeChild(input: { route: NativeChildRoute }, context: HostContext): Promise<NativeHostDescriptor> {
		this.assertActive(context);
		const route = NativeChildRouteSchema.parse(input.route);
		const identity: DurableOwnerIdentity = { durableSessionId: route.child.durableSessionId, conversationId: ROOT_CONVERSATION_ID };
		if (route.placement.parentThreadId === route.threadId || !await this.verifyNativeChild(route, identity)) throw new Error(DENIED);
		this.assertActive(context);
		const rootRoute = this.rootRoutes.get(identity.durableSessionId);
		if (!rootRoute || !this.samePlacement(rootRoute, route) || route.placement.parentThreadId !== rootRoute.threadId) throw new Error(DENIED);
		this.authority.registerNativeChild(route);
		const generation = this.owners.lifecycle(identity)?.generation;
		if (generation === undefined || this.owners.lifecycle(identity)?.kind !== "ready") throw new Error(DENIED);
		const credential = this.authority.issue(route).credential;
		try {
			const view = await this.owners.joinNativeChild({ credential, route });
			try {
				this.assertActive(context);
				this.assertGrantActive(identity, generation, view.identity.generation);
				this.grants.set(credential, { route: structuredClone(route), identity, generation });
				return { endpoint: this.endpoint, credential, generation };
			} finally {
				view.release();
			}
		} catch (error) {
			this.authority.revokeCredential(credential);
			throw error;
		}
	}

	dispose(): Promise<void> {
		if (this.disposePromise) return this.disposePromise;
		this.disposed = true;
		for (const stage of this.staged.values()) clearTimeout(stage.timer);
		this.authority.revokeAll();
		this.grants.clear();
		for (const listener of this.discoveryListeners.values()) listener.unsubscribe();
		this.discoveryListeners.clear();
		this.disposePromise = (async () => {
			const outcomes = await Promise.allSettled([this.transport.close(), this.owners.dispose(),
				...Array.from(this.staged.values(), (stage) => stage.retention.dispose()), ...this.configuring.values()]);
			this.launches.clear();
			this.staged.clear();
			this.stageContext.clear();
			this.configuring.clear();
			this.rootRoutes.clear();
			this.rootSessionByThread.clear();
			this.workerContexts.clear();
			this.lifecycleSignals.clear();
			this.ownerPreparations.clear();
			const failures: unknown[] = outcomes.flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason] : []);
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) throw new AggregateError(failures, "Native child host disposal failed");
		})();
		return this.disposePromise;
	}

	private prepareOwner(identity: DurableOwnerIdentity, route: OrdinaryRootRoute): Promise<ConversationViewLease> {
		const key = identity.durableSessionId;
		const current = this.ownerPreparations.get(key);
		if (current) return current;
		const preparation = this.owners.acquireRoot({ identity, rootRoute: route });
		this.ownerPreparations.set(key, preparation);
		const forget = () => {
			if (this.ownerPreparations.get(key) === preparation) this.ownerPreparations.delete(key);
		};
		void preparation.then(forget, forget);
		return preparation;
	}

	private takeWorkerLease(context: HostContext): void {
		if (this.lifecycleSignals.has(context.lifecycle.signal)) return;
		this.lifecycleSignals.add(context.lifecycle.signal);
		context.lifecycle.signal.addEventListener("abort", () => {
			// Observe event-triggered teardown now; explicit host dispose still gets the cached failure.
			void this.dispose().catch((error: unknown) => console.error("Native child host lifecycle disposal failed:", error));
		}, { once: true });
	}

	private assertActive(context: HostContext): void {
		if (this.disposed || context.lifecycle.signal.aborted || context.signal.aborted) throw new Error(DENIED);
	}

	private async verifyNativeChild(route: NativeChildRoute, identity: DurableOwnerIdentity): Promise<boolean> {
		if (route.child.durableSessionId !== identity.durableSessionId || route.placement.parentThreadId !== this.rootThreadFor(identity)) return false;
		try {
			const result = await this.driver.request(identity, this.owners.lifecycle(identity)?.generation ?? -1, {
				type: "native-child-identity",
				durableSessionId: identity.durableSessionId,
				parentConversationId: ROOT_CONVERSATION_ID,
				childConversationId: route.child.conversationId,
				taskId: route.child.taskId,
			});
			return typeof result === "object" && result !== null
				&& "valid" in result && result.valid === true
				&& "requestId" in result && result.requestId === route.child.requestId
				&& route.child.requestId === `subagent:${route.child.taskId}`;
		} catch { return false; }
	}

	private rootThreadFor(identity: DurableOwnerIdentity): string | undefined {
		return this.rootRoutes.get(identity.durableSessionId)?.threadId;
	}

	private readonly rootRoutes = new Map<string, OrdinaryRootRoute>();

	private samePlacement(root: OrdinaryRootRoute, child: NativeChildRoute): boolean {
		return root.placement.projectId === child.placement.projectId
			&& root.placement.environmentId === child.placement.environmentId
			&& root.placement.hostId === child.placement.hostId
			&& root.placement.providerId === child.placement.providerId;
	}

	private async attachView(request: NativeChildTransportRequest, emit: (event: unknown) => void, signal: AbortSignal): Promise<() => void> {
		const route = this.authority.redeem({ credential: request.credential, expected: request.expected });
		const grant = this.grants.get(request.credential);
		if (!grant || JSON.stringify(grant.route) !== JSON.stringify(route)) throw new Error(DENIED);
		const { identity, generation } = grant;
		const lifecycle = this.owners.lifecycle(identity);
		if (this.disposed || signal.aborted || lifecycle?.kind !== "ready" || lifecycle.generation !== generation) throw new Error(DENIED);
		if (route.kind === "ordinary-root") {
			const lease = await this.owners.acquireRoot({ identity, rootRoute: route });
			try {
				if (signal.aborted) throw new Error(DENIED);
				this.assertGrantActive(identity, generation, lease.identity.generation);
				const unsubscribe = this.driver.subscribeRootEvents(identity, generation, (event) => {
					if (typeof event === "object" && event !== null && "type" in event
						&& (event.type === "native-child-view-event" || event.type === "native-child-discovered")) return;
					emit(event);
				});
				let detached = false;
				return () => {
					if (detached) return;
					detached = true;
					unsubscribe();
					lease.release();
				};
			} catch (error) {
				lease.release();
				throw error;
			}
		}
		const lease = await this.owners.joinNativeChild({ credential: request.credential, route });
		const viewId = randomUUID();
		const target = { durableSessionId: identity.durableSessionId, parentConversationId: ROOT_CONVERSATION_ID, childConversationId: route.child.conversationId, taskId: route.child.taskId, viewId };
		let unsubscribe: (() => void) | undefined;
		let attaching = false;
		let detached = false;
		const detach = () => {
			if (detached) return;
			detached = true;
			unsubscribe?.();
			unsubscribe = undefined;
			lease.release();
			if (attaching) void this.driver.request(identity, generation, { type: "native-child-view-detach", ...target }).catch((error: unknown) => console.error("Native child view detach failed:", error));
		};
		try {
			if (signal.aborted) throw new Error(DENIED);
			this.assertGrantActive(identity, generation, lease.identity.generation);
			unsubscribe = this.driver.subscribeRootEvents(identity, generation, (value) => {
				const frame = NativeChildViewEventSchema.safeParse(value);
				if (!frame.success || frame.data.viewId !== viewId || frame.data.durableSessionId !== identity.durableSessionId
					|| frame.data.taskId !== route.child.taskId || frame.data.childConversationId !== route.child.conversationId) return;
				emit(frame.data.event);
			});
			attaching = true;
			await this.driver.request(identity, generation, { type: "native-child-view-attach", ...target });
			if (signal.aborted) throw new Error(DENIED);
			this.assertGrantActive(identity, generation, lease.identity.generation);
			return detach;
		} catch (error) {
			detach();
			throw error;
		}
	}

	private assertGrantActive(identity: DurableOwnerIdentity, generation: number, viewGeneration: number): void {
		const lifecycle = this.owners.lifecycle(identity);
		if (this.disposed || viewGeneration !== generation || lifecycle?.kind !== "ready" || lifecycle.generation !== generation) throw new Error(DENIED);
	}

	private async handleTransportRequest(request: NativeChildTransportRequest): Promise<unknown> {
		const route = this.authority.redeem({ credential: request.credential, expected: request.expected });
		const grant = this.grants.get(request.credential);
		if (!grant || JSON.stringify(grant.route) !== JSON.stringify(route)) throw new Error(DENIED);
		const identity = grant.identity;
		const generation = grant.generation;
		const lifecycle = this.owners.lifecycle(identity);
		if (this.disposed || request.expected.threadId !== route.threadId) throw new Error(DENIED);
		if (request.command.type === "root-configure") {
			if (route.kind !== "ordinary-root") throw new Error(DENIED);
			return this.configureRoot(grant, request.command.launch);
		}
		if (lifecycle?.kind !== "ready" || lifecycle.generation !== generation) throw new Error(DENIED);
		if (request.command.type === "view-attach") throw new Error(DENIED);
		if (request.command.type === "child-stop") {
			if (route.kind !== "native-child") throw new Error(DENIED);
			const view = await this.owners.joinNativeChild({ credential: request.credential, route });
			try {
				this.assertGrantActive(identity, generation, view.identity.generation);
				const result = await this.driver.request(identity, generation, {
					type: "native-child-stop", durableSessionId: identity.durableSessionId,
					parentConversationId: ROOT_CONVERSATION_ID, childConversationId: route.child.conversationId, taskId: route.child.taskId,
				});
				this.assertGrantActive(identity, generation, view.identity.generation);
				return result;
			} finally { view.release(); }
		}
		if (request.command.type === "bootstrap-ack") {
			if (route.kind !== "native-child") throw new Error(DENIED);
			const view = await this.owners.joinNativeChild({ credential: request.credential, route });
			try {
				if (view.identity.generation !== generation || this.owners.lifecycle(identity)?.kind !== "ready") throw new Error(DENIED);
				this.authority.validateBootstrapControl({ credential: request.credential, expected: request.expected, control: { type: "native-child-bootstrap", requestId: request.command.requestId } });
				return { accepted: true, requestId: route.bootstrapRequestId };
			} finally { view.release(); }
		}
		if (route.kind !== "ordinary-root" || request.command.type !== "root") throw new Error(DENIED);
		const result = await this.driver.request(identity, generation, request.command.command);
		const current = this.owners.lifecycle(identity);
		if (this.disposed || current?.kind !== "ready" || current.generation !== generation) throw new Error(DENIED);
		return result;
	}
}

export function createNativeChildHostHandlers() {
	let service: NativeChildHostService | undefined;
	let servicePath: string | undefined;
	const getService = (context: HostContext): NativeChildHostService => {
		const path = resolve(context.experimental_paths.tempDir);
		if (!service) { service = new NativeChildHostService(context.experimental_paths); servicePath = path; }
		if (servicePath !== path) throw new Error(DENIED);
		return service;
	};
	return {
		handlers: {
			resolveSessionLocation: (input: { providerThreadId: string }, context: HostContext) => {
				if (context.signal.aborted || context.lifecycle.signal.aborted) throw new Error(DENIED);
				const sessionDirectory = resolveSessionFilePath(input.providerThreadId);
				return { sessionDirectory, durableSessionId: basename(sessionDirectory) };
			},
			prepareRoot: (input: { route: OrdinaryRootRoute; durableSessionId: string; launch: Pick<NativeChildLaunchConfig, "cwd" | "sessionDirectory"> }, context: HostContext) => getService(context).prepareRoot(input, context),
			inspectNativeChildIntent: (input: NativeChildIntentHostRequest, context: HostContext) => getService(context).inspectNativeChildIntent(input, context),
			rootReadiness: (input: { parentThreadId: string; durableSessionId: string }, context: HostContext) => getService(context).rootReadiness(input, context),
			discoverNativeChildren: (input: { parentThreadId: string; durableSessionId: string; generation: number }, context: HostContext) => getService(context).discoverNativeChildren(input, context),
			registerNativeChild: (input: { route: z.infer<typeof NativeChildRouteSchema> }, context: HostContext) => getService(context).registerNativeChild({ route: input.route as unknown as NativeChildRoute }, context),
		},
		dispose: async () => { await service?.dispose(); service = undefined; servicePath = undefined; },
	};
}
