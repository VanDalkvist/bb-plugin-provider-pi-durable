import type { NativeChildAuthority } from "./native-child-authority.ts";
import type {
	NativeChildRoute,
	OrdinaryRootRoute,
	RedemptionIdentity,
} from "../native-child-contract.ts";

export type DurableOwnerIdentity = {
	durableSessionId: string;
	conversationId: number;
};

export type ObservedExit =
	| { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
	| { kind: "spawn-failure"; code: null; signal: null; error: Error };

export interface OwnerProcess {
	readonly ready: Promise<DurableOwnerIdentity>;
	readonly observedExit: Promise<ObservedExit>;
	closeInput(): void;
}

export interface OwnerProcessDriver {
	start(identity: DurableOwnerIdentity, generation: number): OwnerProcess;
}

export interface OwnerRetentionLease {
	release(): void | Promise<void>;
}

export interface SharedOwnerOptions {
	authority: NativeChildAuthority;
	driver: OwnerProcessDriver;
	retain: (identity: DurableOwnerIdentity, generation: number) => OwnerRetentionLease | Promise<OwnerRetentionLease>;
	validateChildTask: (route: NativeChildRoute, identity: DurableOwnerIdentity) => boolean | Promise<boolean>;
}

export type OwnerLifecycle =
	| { readonly kind: "starting"; readonly generation: number }
	| { readonly kind: "ready"; readonly generation: number }
	| { readonly kind: "stopping"; readonly generation: number }
	| { readonly kind: "exited"; readonly generation: number; readonly exit: ObservedExit };

export type ConversationViewIdentity = {
	readonly threadId: string;
	readonly conversationId: number;
	readonly generation: number;
};

export interface ConversationViewLease {
	readonly identity: ConversationViewIdentity;
	readonly lifecycle: OwnerLifecycle;
	release(): void;
}

type ViewRecord = {
	identity: ConversationViewIdentity;
	leases: number;
	released: boolean;
};

type OwnerRecord = {
	identity: DurableOwnerIdentity;
	rootRoute: OrdinaryRootRoute;
	generation: number;
	lifecycle: OwnerLifecycle;
	process: OwnerProcess;
	retention: OwnerRetentionLease;
	views: Map<string, ViewRecord>;
	closeRequested: boolean;
	shutdownPromise?: Promise<void>;
	releasePromise?: Promise<void>;
};

type PendingStart = {
	identity: DurableOwnerIdentity;
	rootRoute: OrdinaryRootRoute;
	cancelled: boolean;
	promise: Promise<OwnerRecord>;
};

function ownerKey(identity: DurableOwnerIdentity): string {
	return identity.durableSessionId;
}

function viewKey(identity: ConversationViewIdentity): string {
	return JSON.stringify([identity.threadId, identity.conversationId]);
}

function sameRoot(left: OrdinaryRootRoute, right: OrdinaryRootRoute): boolean {
	return left.threadId === right.threadId
		&& left.providerThreadId === right.providerThreadId
		&& left.placement.parentThreadId === right.placement.parentThreadId
		&& left.placement.projectId === right.placement.projectId
		&& left.placement.environmentId === right.placement.environmentId
		&& left.placement.hostId === right.placement.hostId
		&& left.placement.providerId === right.placement.providerId;
}

function sameOwnerIdentity(left: DurableOwnerIdentity, right: DurableOwnerIdentity): boolean {
	return left.durableSessionId === right.durableSessionId && left.conversationId === right.conversationId;
}

function identityOf(route: OrdinaryRootRoute | NativeChildRoute): RedemptionIdentity {
	if (route.kind === "ordinary-root") {
		return {
			kind: "ordinary-root",
			threadId: route.threadId,
			providerThreadId: route.providerThreadId,
			placement: route.placement,
		};
	}
	return {
		kind: "native-child",
		threadId: route.threadId,
		providerThreadId: route.providerThreadId,
		placement: route.placement,
		child: route.child,
		bootstrapRequestId: route.bootstrapRequestId,
	};
}

function deny(): never {
	throw new Error("Shared Durable owner acquisition denied");
}

export class SharedOwnerRegistry {
	private readonly owners = new Map<string, OwnerRecord>();
	private readonly generations = new Map<string, number>();
	private readonly admissionEpochs = new Map<string, number>();
	private readonly starts = new Map<string, PendingStart>();
	private readonly retentionFailures = new Map<string, unknown>();
	private readonly options: SharedOwnerOptions;
	private disposed = false;
	private disposePromise?: Promise<void>;

	constructor(options: SharedOwnerOptions) {
		this.options = options;
	}

	public async acquireRoot(args: {
		identity: DurableOwnerIdentity;
		rootRoute: OrdinaryRootRoute;
	}): Promise<ConversationViewLease> {
		if (args.rootRoute.kind !== "ordinary-root") deny();
		if (this.disposed) deny();
		const key = ownerKey(args.identity);
		const admissionEpoch = this.admissionEpochs.get(key) ?? 0;
		this.assertRetentionReleased(key);
		let owner = this.owners.get(key);
		if (owner?.lifecycle.kind === "exited") {
			await this.releaseRetention(owner);
			this.assertAdmission(key, admissionEpoch);
			if (this.owners.get(key) === owner) this.owners.delete(key);
			owner = undefined;
		}
		this.assertAdmission(key, admissionEpoch);
		if (owner && (!sameOwnerIdentity(owner.identity, args.identity) || !sameRoot(owner.rootRoute, args.rootRoute))) deny();
		if (!owner) {
			let starting = this.starts.get(key);
			if (starting && (!sameOwnerIdentity(starting.identity, args.identity) || !sameRoot(starting.rootRoute, args.rootRoute))) deny();
			this.assertAdmission(key, admissionEpoch);
			if (!starting) {
				let pending!: PendingStart;
				const promise = Promise.resolve().then(() => this.startOwner(key, pending));
				pending = {
					identity: args.identity,
					rootRoute: structuredClone(args.rootRoute),
					cancelled: false,
					promise,
				};
				starting = pending;
				this.starts.set(key, pending);
			}
			try {
				owner = await starting.promise;
				this.assertAdmission(key, admissionEpoch);
			} finally {
				if (this.starts.get(key) === starting) this.starts.delete(key);
			}
		}
		if (!sameOwnerIdentity(owner.identity, args.identity) || !sameRoot(owner.rootRoute, args.rootRoute)) deny();
		this.assertAdmission(key, admissionEpoch);
		if (owner.lifecycle.kind !== "ready" || this.owners.get(key) !== owner) deny();
		return this.addView(owner, args.rootRoute.threadId, args.identity.conversationId);
	}

	public async joinNativeChild(args: {
		credential: unknown;
		route: NativeChildRoute;
	}): Promise<ConversationViewLease> {
		const expected = identityOf(args.route);
		const route = this.options.authority.redeem({ credential: args.credential, expected });
		if (route.kind !== "native-child") deny();
		const owner = this.owners.get(route.child.durableSessionId);
		if (!owner || owner.lifecycle.kind !== "ready") deny();
		if (owner.identity.durableSessionId !== route.child.durableSessionId) deny();
		if (owner.rootRoute.threadId !== route.placement.parentThreadId
			|| owner.rootRoute.placement.projectId !== route.placement.projectId
			|| owner.rootRoute.placement.environmentId !== route.placement.environmentId
			|| owner.rootRoute.placement.hostId !== route.placement.hostId
			|| owner.rootRoute.placement.providerId !== route.placement.providerId) deny();
		const generation = owner.generation;
		if (!await this.options.validateChildTask(route, owner.identity)) deny();
		if (this.owners.get(route.child.durableSessionId) !== owner
			|| owner.generation !== generation
			|| owner.lifecycle.kind !== "ready") deny();
		const redeemedAgain = this.options.authority.redeem({ credential: args.credential, expected });
		if (redeemedAgain.kind !== "native-child"
			|| owner.identity.durableSessionId !== redeemedAgain.child.durableSessionId) deny();
		return this.addView(owner, route.threadId, route.child.conversationId);
	}

	public lifecycle(identity: DurableOwnerIdentity): OwnerLifecycle | undefined {
		const owner = this.owners.get(ownerKey(identity));
		if (!owner || !sameOwnerIdentity(owner.identity, identity)) return undefined;
		return structuredClone(owner.lifecycle);
	}

	public async shutdown(identity: DurableOwnerIdentity): Promise<void> {
		const key = ownerKey(identity);
		const pending = this.starts.get(key);
		const owner = this.owners.get(key);
		if (pending && !sameOwnerIdentity(pending.identity, identity)) deny();
		if (owner && !sameOwnerIdentity(owner.identity, identity)) deny();
		this.admissionEpochs.set(key, (this.admissionEpochs.get(key) ?? 0) + 1);
		this.assertRetentionReleased(key);
		if (pending) pending.cancelled = true;
		const tasks: Promise<void>[] = [];
		if (owner) tasks.push(this.shutdownOwner(owner));
		if (pending) tasks.push(pending.promise.then((started) => this.shutdownOwner(started), (error: unknown) => {
			if (this.retentionFailures.has(key)) throw error;
		}));
		await Promise.all(tasks);
	}

	public dispose(): Promise<void> {
		return this.disposePromise ??= this.drainAndDispose();
	}

	private async drainAndDispose(): Promise<void> {
		this.disposed = true;
		const pending = [...this.starts.values()];
		for (const start of pending) start.cancelled = true;
		const owners = [...this.owners.values()];
		await Promise.all([
			...owners.map((owner) => this.shutdownOwner(owner)),
			...pending.map((start) => start.promise.then((owner) => this.shutdownOwner(owner), (error: unknown) => {
				if (this.retentionFailures.has(ownerKey(start.identity))) throw error;
			})),
		]);
	}

	private shutdownOwner(owner: OwnerRecord): Promise<void> {
		return owner.shutdownPromise ??= (async () => {
			if (!owner.closeRequested && owner.lifecycle.kind !== "exited") {
				owner.closeRequested = true;
				owner.lifecycle = { kind: "stopping", generation: owner.generation };
				owner.process.closeInput();
			}
			await owner.process.observedExit;
			owner.lifecycle = { kind: "exited", generation: owner.generation, exit: await owner.process.observedExit };
			await this.releaseRetention(owner);
			const key = ownerKey(owner.identity);
			if (this.owners.get(key) === owner) this.owners.delete(key);
		})();
	}

	private async startOwner(key: string, pending: PendingStart): Promise<OwnerRecord> {
		const { identity, rootRoute } = pending;
		const generation = (this.generations.get(key) ?? 0) + 1;
		this.generations.set(key, generation);
		const retention = await this.options.retain(identity, generation);
		if (pending.cancelled || this.disposed) {
			try {
				await retention.release();
			} catch (error) {
				this.retentionFailures.set(key, error);
				throw error;
			}
			deny();
		}
		let process: OwnerProcess;
		try {
			process = this.options.driver.start(identity, generation);
		} catch (error) {
			try {
				await retention.release();
			} catch (releaseError) {
				this.retentionFailures.set(key, releaseError);
				throw releaseError;
			}
			throw error;
		}
		const owner: OwnerRecord = {
			identity: Object.freeze({ ...identity }),
			rootRoute: structuredClone(rootRoute),
			generation,
			lifecycle: { kind: "starting", generation },
			process,
			retention,
			views: new Map(),
			closeRequested: false,
		};
		this.owners.set(key, owner);
		void process.observedExit.then(async (exit) => {
			owner.lifecycle = { kind: "exited", generation, exit };
			try {
				await this.releaseRetention(owner);
				if (this.owners.get(key) === owner) this.owners.delete(key);
			} catch (error) {
				owner.lifecycle = { kind: "stopping", generation };
				console.error("[SharedOwner] Retention release failed after runner exit:", error);
			}
		}).catch((error: unknown) => {
			console.error("[SharedOwner] Exit handling failed:", error);
		});
		if (pending.cancelled || this.disposed) {
			owner.lifecycle = { kind: "stopping", generation };
			owner.closeRequested = true;
			owner.process.closeInput();
			deny();
		}
		try {
			const actual = await process.ready;
			if (!sameOwnerIdentity(actual, identity)) deny();
			if (owner.lifecycle.kind !== "starting" || pending.cancelled || this.disposed) deny();
			owner.lifecycle = { kind: "ready", generation };
			return owner;
		} catch (error) {
			if (owner.lifecycle.kind === "starting") owner.lifecycle = { kind: "stopping", generation };
			throw error;
		}
	}

	private assertAdmission(key: string, epoch: number): void {
		if (this.disposed || (this.admissionEpochs.get(key) ?? 0) !== epoch) deny();
	}

	private assertRetentionReleased(key: string): void {
		if (this.retentionFailures.has(key)) throw this.retentionFailures.get(key);
	}

	private releaseRetention(owner: OwnerRecord): Promise<void> {
		return owner.releasePromise ??= Promise.resolve().then(() => owner.retention.release()).then(() => undefined);
	}

	private addView(owner: OwnerRecord, threadId: string, conversationId: number): ConversationViewLease {
		const identity: ConversationViewIdentity = Object.freeze({ threadId, conversationId, generation: owner.generation });
		const key = viewKey(identity);
		const existing = owner.views.get(key);
		if (existing && !existing.released) {
			existing.leases++;
			return this.viewLease(owner, existing);
		}
		const view: ViewRecord = { identity, leases: 1, released: false };
		owner.views.set(key, view);
		return this.viewLease(owner, view);
	}

	private viewLease(owner: OwnerRecord, view: ViewRecord): ConversationViewLease {
		let released = false;
		return {
			identity: view.identity,
			get lifecycle() { return structuredClone(owner.lifecycle); },
			release() {
				if (released) return;
				released = true;
				view.leases--;
				if (view.leases === 0) {
					view.released = true;
					owner.views.delete(viewKey(view.identity));
				}
			},
		};
	}
}
