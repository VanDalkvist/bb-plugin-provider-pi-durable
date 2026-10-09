import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
	BootstrapControlSchema,
	RedemptionIdentitySchema,
	routeKey,
	type NativeChildRoute,
	type OrdinaryRootRoute,
	type RegisteredRoute,
	type RedemptionIdentity,
} from "../native-child-contract.ts";

const MAX_CREDENTIAL_LIFETIME_MS = 5 * 60 * 1000;
const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DENIED = "Native child authorization denied";

type RouteKey = string;
type CredentialRecord = {
	routeKey: RouteKey;
	generation: number;
	expiresAt: number;
	revoked: boolean;
};

export type IssuedNativeChildCredential = {
	/** Secret transport material. Never place in provider input, metadata, history, or logs. */
	credential: string;
};

export type NativeChildAuthorityOptions = {
	/** A host-owned monotonic clock; injection is intended for deterministic expiry tests. */
	now?: () => number;
};

function hashCredential(credential: string): string {
	return createHash("sha256").update(credential, "utf8").digest("hex");
}

function samePlacement(
	left: RegisteredRoute["placement"],
	right: RedemptionIdentity["placement"],
): boolean {
	return left.parentThreadId === right.parentThreadId
		&& left.projectId === right.projectId
		&& left.environmentId === right.environmentId
		&& left.hostId === right.hostId
		&& left.providerId === right.providerId;
}

function snapshotRoute(route: RegisteredRoute): RegisteredRoute {
	if (route.kind === "ordinary-root") {
		return Object.freeze({ ...route, placement: Object.freeze({ ...route.placement }) });
	}
	return Object.freeze({
		...route,
		placement: Object.freeze({ ...route.placement }),
		child: Object.freeze({ ...route.child }),
	});
}

function sameRoute(left: RegisteredRoute, right: RegisteredRoute): boolean {
	if (left.kind !== right.kind
		|| left.threadId !== right.threadId
		|| left.providerThreadId !== right.providerThreadId
		|| !samePlacement(left.placement, right.placement)) return false;
	if (left.kind === "ordinary-root" && right.kind === "ordinary-root") return true;
	if (left.kind === "native-child" && right.kind === "native-child") {
		return left.child.durableSessionId === right.child.durableSessionId
			&& left.child.taskId === right.child.taskId
			&& left.child.conversationId === right.child.conversationId
			&& left.child.requestId === right.child.requestId
			&& left.bootstrapRequestId === right.bootstrapRequestId;
	}
	return false;
}

function matchesExpected(route: RegisteredRoute, expected: RedemptionIdentity): boolean {
	if (route.kind !== expected.kind
		|| route.threadId !== expected.threadId
		|| route.providerThreadId !== expected.providerThreadId
		|| !samePlacement(route.placement, expected.placement)) return false;
	if (route.kind === "ordinary-root" && expected.kind === "ordinary-root") return true;
	if (route.kind === "native-child" && expected.kind === "native-child") {
		return route.child.durableSessionId === expected.child.durableSessionId
			&& route.child.taskId === expected.child.taskId
			&& route.child.conversationId === expected.child.conversationId
			&& route.child.requestId === expected.child.requestId
			&& route.bootstrapRequestId === expected.bootstrapRequestId;
	}
	return false;
}

export class NativeChildAuthority {
	private readonly routes = new Map<RouteKey, RegisteredRoute>();
	private readonly credentials = new Map<string, CredentialRecord>();
	private readonly now: () => number;
	private highestObservedTime: number | undefined;
	private generation = 1;
	private active = true;

	constructor(options: NativeChildAuthorityOptions = {}) {
		this.now = options.now ?? (() => performance.now());
	}

	/** Trusted host/control-plane registration. Provider redemption data cannot call this operation. */
	registerRoot(route: OrdinaryRootRoute): void {
		this.register(route);
	}

	/** Trusted native/host control-plane registration; never expose this as a provider operation. */
	registerNativeChild(route: NativeChildRoute): void {
		this.register(route);
	}

	private register(route: RegisteredRoute): void {
		if (!this.active) throw new Error(DENIED);
		const key = routeKey(route);
		const current = this.routes.get(key);
		if (current !== undefined) {
			if (sameRoute(current, route)) return;
			throw new Error(DENIED);
		}
		this.routes.set(key, snapshotRoute(route));
	}

	/** Trusted issuance only. Credentials are random opaque handles and the registry is authoritative. */
	issue(routeIdentity: Pick<RegisteredRoute, "threadId" | "providerThreadId">, lifetimeMs = MAX_CREDENTIAL_LIFETIME_MS): IssuedNativeChildCredential {
		if (!this.active || !Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > MAX_CREDENTIAL_LIFETIME_MS) {
			throw new Error(DENIED);
		}
		const key = routeKey(routeIdentity);
		if (!this.routes.has(key)) throw new Error(DENIED);
		const issuedAt = this.sampleTime();
		const expiresAt = issuedAt + lifetimeMs;
		if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) throw new Error(DENIED);
		const credential = randomBytes(32).toString("base64url");
		this.credentials.set(hashCredential(credential), {
			routeKey: key,
			generation: this.generation,
			expiresAt,
			revoked: false,
		});
		return { credential };
	}

	/** Redeems only the registry route matching every expected identity field exactly. */
	redeem(input: { credential: unknown; expected: unknown }): RegisteredRoute {
		const credential = this.parseCredential(input.credential);
		const expected = RedemptionIdentitySchema.safeParse(input.expected);
		if (credential === undefined || !expected.success || !this.active) throw new Error(DENIED);
		const record = this.credentials.get(hashCredential(credential));
		const now = this.sampleTime();
		if (!Number.isFinite(now) || record === undefined || record.revoked || record.generation !== this.generation || now >= record.expiresAt) {
			throw new Error(DENIED);
		}
		const route = this.routes.get(record.routeKey);
		if (route === undefined || !matchesExpected(route, expected.data)) throw new Error(DENIED);
		return snapshotRoute(route);
	}

	/** Child bootstrap admission is exact and one-shot-shaped; v1 grants no ordinary child follow-ups. */
	validateBootstrapControl(input: { credential: unknown; expected: unknown; control: unknown }): NativeChildRoute {
		const route = this.redeem(input);
		const control = BootstrapControlSchema.safeParse(input.control);
		if (route.kind !== "native-child" || !control.success || control.data.requestId !== route.bootstrapRequestId) {
			throw new Error(DENIED);
		}
		return route;
	}

	revokeCredential(credentialInput: unknown): void {
		const credential = this.parseCredential(credentialInput);
		if (credential === undefined) throw new Error(DENIED);
		const record = this.credentials.get(hashCredential(credential));
		if (record === undefined) throw new Error(DENIED);
		record.revoked = true;
	}

	/** Trusted owner-generation replacement fences every route and credential from the previous owner generation. */
	advanceGeneration(): void {
		if (!this.active || this.generation >= Number.MAX_SAFE_INTEGER) throw new Error(DENIED);
		this.generation += 1;
		this.routes.clear();
		this.credentials.clear();
	}

	/** Terminal shutdown is fail-closed; a new owner must construct a fresh authority. */
	revokeAll(): void {
		this.active = false;
		this.routes.clear();
		this.credentials.clear();
	}

	private sampleTime(): number {
		const now = this.now();
		if (!Number.isFinite(now) || (this.highestObservedTime !== undefined && now < this.highestObservedTime)) {
			return Number.NaN;
		}
		this.highestObservedTime = now;
		return now;
	}

	private parseCredential(input: unknown): string | undefined {
		if (typeof input !== "string" || !CREDENTIAL_PATTERN.test(input)) return undefined;
		return input;
	}
}
