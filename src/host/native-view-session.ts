import { z } from "zod";
import { BootstrapControlSchema, RedemptionIdentitySchema, type RedemptionIdentity } from "../native-child-contract.ts";
import { NATIVE_CHILD_CREDENTIAL_ENV, NATIVE_CHILD_SOCKET_ENV, NATIVE_CHILD_ROUTE_ENV } from "../native-child-host-contract.ts";
import { NativeChildTransportClient, RootConfigureResponseSchema, type NativeChildTransportRequest, type NativeChildViewClient } from "./native-child-transport.ts";
import type { RunnerEvent, SessionOptions } from "./types.ts";
import { createContextWindowDelta, extractSessionStats } from "./session-telemetry.ts";

export interface ThreadSession {
	readonly exited: boolean;
	options: Pick<SessionOptions, "threadId" | "providerThreadId" | "cwd" | "providerOptions">;
	start(): Promise<void>;
	prompt(text: string): Promise<void>;
	steer(text: string): Promise<void>;
	abort(): Promise<void>;
	compact(instructions?: string): Promise<void>;
	refreshContextUsage(): Promise<void>;
	closeGracefully(): Promise<void>;
}

export type NativeViewConnection = {
	endpoint: string;
	credential: string;
	expected: RedemptionIdentity;
};

export function resolveNativeViewConnection(options: {
	threadId: string;
	providerThreadId?: string;
	providerOptions: unknown;
	environment: unknown;
}): NativeViewConnection | undefined {
	const provider = z.record(z.string(), z.unknown()).parse(options.providerOptions ?? {});
	const environment = z.record(z.string(), z.string()).parse(options.environment ?? {});
	let route = provider.nativeDurableRoute;
	const privateRoute = environment[NATIVE_CHILD_ROUTE_ENV];
	if (privateRoute !== undefined) {
		let decoded: unknown;
		try { decoded = JSON.parse(privateRoute); } catch { throw new Error("Native Durable view denied"); }
		const parsed = RedemptionIdentitySchema.parse(decoded);
		if (route !== undefined && JSON.stringify(RedemptionIdentitySchema.parse(route)) !== JSON.stringify(parsed)) throw new Error("Native Durable view denied");
		route = parsed;
	}
	const endpoint = environment[NATIVE_CHILD_SOCKET_ENV];
	const credential = environment[NATIVE_CHILD_CREDENTIAL_ENV];
	if (route === undefined && endpoint === undefined && credential === undefined && provider.nativeDurableRequired !== true) return undefined;
	const expected = RedemptionIdentitySchema.parse(route);
	if (!endpoint || !credential || expected.threadId !== options.threadId || (options.providerThreadId !== undefined && expected.providerThreadId !== options.providerThreadId)) {
		throw new Error("Native Durable view denied");
	}
	return { endpoint, credential, expected };
}

const eventSchema = z.object({ type: z.string().min(1) }).catchall(z.unknown());

type RootLaunch = Extract<NativeChildTransportRequest["command"], { type: "root-configure" }>["launch"];

export class NativeViewSession implements ThreadSession {
	public readonly options: ThreadSession["options"];
	private detach: (() => void) | undefined;
	private starting: Promise<void> | undefined;
	private closed = false;
	private readonly client: NativeChildViewClient;
	private readonly connection: NativeViewConnection;
	private readonly rootLaunch?: RootLaunch;
	private selectedModel?: { provider: string; id: string };
	private selectedThinking?: string;
	private configuring: Promise<void> = Promise.resolve();

	constructor(options: {
		connection: NativeViewConnection;
		session: ThreadSession["options"];
		onEvent: (event: RunnerEvent) => void;
		onContextUsage?: (delta: NonNullable<ReturnType<typeof createContextWindowDelta>>) => void;
		rootLaunch?: RootLaunch;
		createClient?: (connection: NativeViewConnection) => NativeChildViewClient;
	}) {
		this.options = { ...options.session };
		this.connection = structuredClone(options.connection);
		this.rootLaunch = options.rootLaunch && structuredClone(options.rootLaunch);
		if ((options.connection.expected.kind === "ordinary-root") !== Boolean(this.rootLaunch)) {
			throw new Error("Native Durable root context missing");
		}
		this.route = structuredClone(options.connection.expected);
		this.onEvent = options.onEvent;
		this.onContextUsage = options.onContextUsage;
		this.client = (options.createClient ?? ((connection) => new NativeChildTransportClient(connection)))(options.connection);
	}

	private readonly route: RedemptionIdentity;
	private readonly onEvent: (event: RunnerEvent) => void;
	private readonly onContextUsage?: (delta: NonNullable<ReturnType<typeof createContextWindowDelta>>) => void;
	get exited(): boolean { return this.closed; }

	matches(connection: NativeViewConnection, providerThreadId: string, cwd?: string, rootLaunch?: RootLaunch): boolean {
		const original = this.rootLaunch;
		return !this.closed && this.options.providerThreadId === providerThreadId
			&& this.options.cwd === cwd && this.connection.endpoint === connection.endpoint
			&& this.connection.credential === connection.credential
			&& JSON.stringify(this.route) === JSON.stringify(connection.expected)
			&& (original === undefined && rootLaunch === undefined || original !== undefined && rootLaunch !== undefined
				&& original.cwd === rootLaunch.cwd && original.appendSystemPrompt === rootLaunch.appendSystemPrompt
				&& JSON.stringify(Object.entries(original.environment).sort()) === JSON.stringify(Object.entries(rootLaunch.environment).sort()));
	}

	start(): Promise<void> {
		if (this.closed) return Promise.reject(new Error("Native Durable view closed"));
		if (!this.starting) {
			this.starting = (async () => {
				if (this.rootLaunch) {
					const ack = RootConfigureResponseSchema.parse(await this.request({ type: "root-configure", launch: this.rootLaunch }));
					if (this.closed || ack.generation < 1) throw new Error("Native Durable view closed");
					// Only a successful host attestation can establish what was actually launched.
					this.selectedModel = { provider: this.rootLaunch.model.provider, id: this.rootLaunch.model.modelId };
					this.selectedThinking = this.rootLaunch.thinking;
				}
				const detach = await this.client.attachRootView((value) => {
					if (this.closed) return;
					const event = eventSchema.safeParse(value);
					if (event.success) this.onEvent(event.data);
				}, () => {
					// Remote loss is not a child/root stop. Evict this view and require fresh admission.
					this.closed = true;
					this.detach = undefined;
				});
				if (this.closed) { detach(); throw new Error("Native Durable view closed"); }
				this.detach = detach;
			})();
		}
		return this.starting;
	}

	configureExecution(model?: { provider: string; id: string }, thinking?: string): Promise<void> {
		if (model === undefined && thinking === undefined) return this.configuring;
		const update = this.configuring.then(async () => {
			this.assertOpen();
			if (this.route.kind !== "ordinary-root") throw new Error("Native child execution settings are immutable");
			if (model && (model.provider !== this.selectedModel?.provider || model.id !== this.selectedModel.id)) {
				await this.request({ type: "root", command: { type: "set_model", provider: model.provider, modelId: model.id } });
				this.selectedModel = { ...model };
			}
			if (thinking !== undefined && thinking !== this.selectedThinking) {
				await this.request({ type: "root", command: { type: "set_thinking_level", level: thinking } });
				this.selectedThinking = thinking;
			}
		});
		this.configuring = update.catch(() => undefined);
		return update;
	}

	async prompt(text: string): Promise<void> {
		this.assertOpen();
		if (this.route.kind === "ordinary-root") {
			await this.request({ type: "root", command: { type: "prompt", message: text } });
			return;
		}
		let value: unknown;
		try { value = JSON.parse(text); } catch { throw new Error("Native child follow-up denied"); }
		const control = BootstrapControlSchema.safeParse(value);
		if (!control.success || control.data.requestId !== this.route.bootstrapRequestId) throw new Error("Native child follow-up denied");
		await this.request({ type: "bootstrap-ack", requestId: control.data.requestId });
	}

	async steer(text: string): Promise<void> {
		this.assertOpen();
		if (this.route.kind !== "ordinary-root") throw new Error("Native child follow-up denied");
		await this.request({ type: "root", command: { type: "steer", message: text } });
	}

	async abort(): Promise<void> {
		this.assertOpen();
		await this.request(this.route.kind === "native-child" ? { type: "child-stop" } : { type: "root", command: { type: "abort" } });
	}

	async compact(instructions?: string): Promise<void> {
		this.assertOpen();
		if (this.route.kind !== "ordinary-root") throw new Error("Native child views are read-only");
		await this.request({ type: "root", command: { type: "compact", instructions } });
	}

	async refreshContextUsage(): Promise<void> {
		this.assertOpen();
		if (this.route.kind === "ordinary-root") {
			const stats = extractSessionStats(await this.request({ type: "root", command: { type: "get_session_stats" } }));
			const delta = createContextWindowDelta(stats);
			if (delta && !this.closed) this.onContextUsage?.(delta);
		}
	}

	async closeGracefully(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const detach = this.detach;
		this.detach = undefined;
		detach?.();
		// An outstanding attach observes closed and releases its lease when it resolves.
		void this.starting?.catch(() => undefined);
	}

	private async request(command: NativeChildTransportRequest["command"]): Promise<unknown> {
		this.assertOpen();
		try {
			const result = await this.client.request(command);
			this.assertOpen();
			return result;
		} catch (error) {
			// A denied/stale grant cannot remain an apparently healthy cached view.
			try { await this.closeGracefully(); } catch { /* preserve transport failure */ }
			throw error;
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("Native Durable view closed");
	}
}
