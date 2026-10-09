import { requireExtensionPath, requireScratchDir, resolveSessionDir, resolveSessionFilePath } from "./paths.ts";
import { PiThreadSession } from "./session.ts";
import { NativeViewSession, resolveNativeViewConnection, type ThreadSession } from "./native-view-session.ts";
import { DeltaTranslator } from "./delta-translator.ts";
import { isAbsolute, resolve } from "node:path";
import { NATIVE_CHILD_CREDENTIAL_ENV, NATIVE_CHILD_ROUTE_ENV, NATIVE_CHILD_SOCKET_ENV } from "../native-child-host-contract.ts";
import type { NativeChildTransportRequest } from "./native-child-transport.ts";

function parseRequestedModel(value: unknown): { provider: string; id: string } | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") {
		const slash = value.indexOf("/");
		if (slash > 0 && slash < value.length - 1) return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
	} else if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const id = record.id ?? record.modelId;
		if (typeof record.provider === "string" && record.provider && typeof id === "string" && id) return { provider: record.provider, id };
	}
	throw new Error("Invalid requested model");
}

type RootLaunch = Extract<NativeChildTransportRequest["command"], { type: "root-configure" }>["launch"];
const privateEnv = new Set([NATIVE_CHILD_CREDENTIAL_ENV, NATIVE_CHILD_ROUTE_ENV, NATIVE_CHILD_SOCKET_ENV, "BB_PI_DURABLE_PARENT_THREAD_ID"]);

function requestedRootLaunch(params: any, cwd: string | undefined): RootLaunch {
	const model = parseRequestedModel(params.model ?? params.options?.model);
	const thinking = params.thinkingLevel ?? params.options?.reasoningLevel ?? params.options?.thinkingLevel;
	const raw = params.shellEnvOverrides ?? params.options?.envVars;
	if (!cwd || !isAbsolute(cwd) || resolve(cwd) !== cwd || !model
		|| typeof thinking !== "string" || !thinking || !raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("Native Durable root context missing");
	}
	const environment: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value !== "string") throw new Error("Native Durable root context invalid");
		if (!privateEnv.has(key)) environment[key] = value;
	}
	const appendSystemPrompt = params.appendSystemPrompt ?? params.options?.appendSystemPrompt;
	if (appendSystemPrompt !== undefined && typeof appendSystemPrompt !== "string") throw new Error("Native Durable root context invalid");
	return { cwd, model: { provider: model.provider, modelId: model.id }, thinking: thinking === "none" ? "off" : thinking,
		...(appendSystemPrompt ? { appendSystemPrompt } : {}), environment };
}

export class SessionRegistry {
	private sendNotification: (method: string, params: Record<string, unknown>) => void;
	private sessions = new Map<string, ThreadSession>();
	private starting = new Map<string, Promise<void>>();
	private readonly createNativeSession: (options: ConstructorParameters<typeof NativeViewSession>[0]) => NativeViewSession;

	constructor(sendNotification: (method: string, params: Record<string, unknown>) => void,
		dependencies: { createNativeSession?: (options: ConstructorParameters<typeof NativeViewSession>[0]) => NativeViewSession } = {}) {
		this.sendNotification = sendNotification;
		this.createNativeSession = dependencies.createNativeSession ?? ((options) => new NativeViewSession(options));
	}

	public get(threadId: string): ThreadSession | undefined {
		const session = this.sessions.get(threadId);
		if (session && (session.exited || (session as PiThreadSession).runner?.exited)) {
			this.sessions.delete(threadId);
			return undefined;
		}
		return session;
	}

	public async createOrGet(
		threadId: string,
		providerThreadId: string,
		params: any,
	): Promise<ThreadSession> {
		const connection = resolveNativeViewConnection({
			threadId, providerThreadId,
			providerOptions: params.options?.providerOptions ?? params.providerOptions,
			environment: params.shellEnvOverrides ?? params.options?.envVars,
		});
		if (connection?.expected.kind === "native-child" && (params.appendSystemPrompt !== undefined || params.options?.appendSystemPrompt !== undefined)) {
			throw new Error("Native child execution settings are immutable");
		}
		const existing = this.sessions.get(threadId);
		const cwd = params.cwd ?? params.options?.cwd ?? existing?.options.cwd;
		const rootLaunch = connection?.expected.kind === "ordinary-root" ? requestedRootLaunch(params, cwd) : undefined;
		if (existing && !existing.exited) {
			if (existing instanceof NativeViewSession) {
				if (!connection || !existing.matches(connection, providerThreadId, cwd, rootLaunch)) throw new Error("Native Durable view admission changed");
			} else if (connection || existing.options.providerThreadId !== providerThreadId) {
				throw new Error("Native Durable view admission changed");
			}
			await this.starting.get(threadId);
			if (this.sessions.get(threadId) !== existing || existing.exited) throw new Error("Native Durable view closed");
			if (existing instanceof NativeViewSession) {
				const model = parseRequestedModel(params.model ?? params.options?.model);
				const thinking = params.thinkingLevel ?? params.options?.reasoningLevel ?? params.options?.thinkingLevel;
				await existing.configureExecution(model, thinking === "none" ? "off" : thinking);
			}
			return existing;
		}
		if (existing) this.sessions.delete(threadId);

		const resolvedModel = parseRequestedModel(params.model ?? params.options?.model);

		const rawThinking = params.thinkingLevel ?? params.options?.reasoningLevel ?? params.options?.thinkingLevel;
		const rawEnv = params.shellEnvOverrides ?? params.options?.envVars;
		const providerOptions = params.options?.providerOptions ?? params.providerOptions;

		if (connection) {
			const translator = new DeltaTranslator();
			const viewProviderOptions = structuredClone(providerOptions);
			const session = this.createNativeSession({
				connection,
				session: { threadId, providerThreadId, cwd, providerOptions: viewProviderOptions },
				rootLaunch,
				onContextUsage: (delta) => {
					if (this.sessions.get(threadId) === session && !session.exited) this.sendNotification("thread/delta", { threadId, deltas: [delta] });
				},
				onEvent: (event) => {
					if (this.sessions.get(threadId) !== session || session.exited) return;
					const deltas = translator.translate(event, { threadId, cwd, providerOptions: viewProviderOptions });
					if (deltas.length > 0) this.sendNotification("thread/delta", { threadId, deltas });
					if (connection.expected.kind === "ordinary-root" && (event.type === "turn_end" || event.type === "compaction_end")) {
						void session.refreshContextUsage().catch((error: unknown) => {
							console.warn(`[NativeViewSession] Context refresh failed: ${String(error)}`);
						});
					}
				},
			});
			this.sessions.set(threadId, session);
			const startup = session.start();
			this.starting.set(threadId, startup);
			try {
				await startup;
				if (this.sessions.get(threadId) !== session || session.exited) throw new Error("Native Durable view closed");
				this.sendNotification("thread/identity", { threadId, providerThreadId, sessionRestorable: true });
				return session;
			} catch (error) {
				if (this.sessions.get(threadId) === session) this.sessions.delete(threadId);
				await session.closeGracefully();
				throw error;
			} finally {
				if (this.starting.get(threadId) === startup) this.starting.delete(threadId);
			}
		}

		const sessionDir = resolveSessionDir();
		const sessionFilePath = resolveSessionFilePath(providerThreadId);
		const extensionPath = requireExtensionPath();
		const scratchDir = requireScratchDir();

		const session = new PiThreadSession(
			{
				threadId,
				providerThreadId,
				cwd: params.cwd,
				sessionFilePath,
				sessionDir,
				extensionPath,
				scratchDir,
				model: resolvedModel,
				thinkingLevel: rawThinking,
				shellEnvOverrides: rawEnv,
				appendSystemPrompt: params.appendSystemPrompt,
				providerOptions,
			},
			this.sendNotification,
		);

		await session.start();
		this.sessions.set(threadId, session);

		// Send initial identity & reset boundary
		this.sendNotification("thread/identity", {
			threadId,
			providerThreadId,
			sessionRestorable: true,
		});
		this.sendNotification("thread/delta", {
			threadId,
			deltas: [{ kind: "session.reset" }],
		});

		return session;
	}

	public async reconcileCwd(threadId: string, targetCwd?: string): Promise<ThreadSession | undefined> {
		const session = this.get(threadId);
		if (!session) {
			return undefined;
		}
		if (!targetCwd || session.options.cwd === targetCwd) {
			return session;
		}

		if (session instanceof NativeViewSession) throw new Error("Native Durable view workspace change requires trusted re-admission");

		// Workspace location changed, recreate session in new directory
		await session.closeGracefully();
		this.sessions.delete(threadId);

		const updatedParams = {
			...session.options,
			cwd: targetCwd,
		};
		return this.createOrGet(threadId, session.options.providerThreadId, updatedParams);
	}

	public async stop(threadId: string): Promise<void> {
		const session = this.sessions.get(threadId);
		if (session) {
			this.sessions.delete(threadId);
			await session.closeGracefully();
		}
	}

	public async stopAll(): Promise<void> {
		await Promise.all([...this.sessions.keys()].map((threadId) => this.stop(threadId)));
	}
}
