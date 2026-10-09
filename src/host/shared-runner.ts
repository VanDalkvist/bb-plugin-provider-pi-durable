import { z } from "zod";
import { RunnerProcess, type RunnerProcessOptions } from "./runner-process.ts";
import type {
	DurableOwnerIdentity,
	ObservedExit,
	OwnerProcess,
	OwnerProcessDriver,
} from "./shared-owner.ts";

const RunnerIdentitySchema = z.object({
	durableSessionId: z.string().min(1),
	conversationId: z.number().int().safe().nonnegative(),
});

type RunnerLaunchOptions = Pick<RunnerProcessOptions, "cwd" | "args" | "env">;
type RunnerProcessHandle = Pick<RunnerProcess, "observedExit" | "requestOk" | "closeInput">;
export type RunnerProcessFactory = (options: RunnerProcessOptions) => RunnerProcessHandle;

export type SharedRunnerCommand =
	| { type: "native-child-identity" | "native-child-intent" | "native-child-stop"; durableSessionId: string; parentConversationId: number; childConversationId: number; taskId: number }
	| { type: "native-child-view-attach" | "native-child-view-detach"; durableSessionId: string; parentConversationId: number; childConversationId: number; taskId: number; viewId: string }
	| { type: "native-child-discover"; durableSessionId: string; parentConversationId: number }
	| { type: "prompt" | "steer"; message: string; streamingBehavior?: "steer" | "followUp" }
	| { type: "compact"; instructions?: string }
	| { type: "abort" | "get_session_stats" }
	| { type: "set_model"; provider: string; modelId: string }
	| { type: "set_thinking_level"; level: string };

export class RunnerProcessDriver implements OwnerProcessDriver {
	private readonly launch: (identity: DurableOwnerIdentity, generation: number) => RunnerLaunchOptions;
	private readonly runners = new Map<string, { generation: number; identity: DurableOwnerIdentity; runner: RunnerProcessHandle }>();
	private readonly rootEventListeners = new Map<string, Set<(event: unknown) => void>>();
	private readonly createRunner: RunnerProcessFactory;

	constructor(launch: (identity: DurableOwnerIdentity, generation: number) => RunnerLaunchOptions, createRunner: RunnerProcessFactory = (options) => new RunnerProcess(options)) {
		this.launch = launch;
		this.createRunner = createRunner;
	}

	public async request(identity: DurableOwnerIdentity, generation: number, command: SharedRunnerCommand): Promise<unknown> {
		const active = this.runners.get(identity.durableSessionId);
		if (!active || active.generation !== generation || active.identity.conversationId !== identity.conversationId) {
			throw new Error("Shared runner capability denied");
		}
		return active.runner.requestOk(command);
	}

	public subscribeRootEvents(identity: DurableOwnerIdentity, generation: number, listener: (event: unknown) => void): () => void {
		const active = this.runners.get(identity.durableSessionId);
		if (!active || active.generation !== generation || active.identity.conversationId !== identity.conversationId) {
			throw new Error("Shared runner capability denied");
		}
		const key = identity.durableSessionId;
		let listeners = this.rootEventListeners.get(key);
		if (!listeners) this.rootEventListeners.set(key, listeners = new Set());
		listeners.add(listener);
		return () => {
			listeners?.delete(listener);
			if (listeners?.size === 0) this.rootEventListeners.delete(key);
		};
	}

	public start(identity: DurableOwnerIdentity, generation: number): OwnerProcess {
		const options = structuredClone(this.launch(identity, generation));
		let runner: RunnerProcessHandle;
		let readySettled = false;
		let readyResolve!: (identity: DurableOwnerIdentity) => void;
		let readyReject!: (error: Error) => void;
		const ready = new Promise<DurableOwnerIdentity>((resolve, reject) => {
			readyResolve = resolve;
			readyReject = reject;
		});
		const failReady = (error: Error): void => {
			if (readySettled) return;
			readySettled = true;
			readyReject(error);
		};
		runner = this.createRunner({
			...options,
			onEvent: (event) => {
				const active = this.runners.get(identity.durableSessionId);
				if (active?.generation !== generation) return;
				for (const listener of this.rootEventListeners.get(identity.durableSessionId) ?? []) {
					try { listener(event); } catch { continue; }
				}
			},
			onChannelMessage: (message) => {
				if (typeof message !== "object" || message === null || !("kind" in message) || message.kind !== "ready") return;
				void runner.requestOk({ type: "get_state" }).then((result: unknown) => {
					const parsed = RunnerIdentitySchema.safeParse(result);
					if (!parsed.success) {
						failReady(new Error("Runner returned invalid Durable owner identity"));
						return;
					}
					if (readySettled) return;
					readySettled = true;
					readyResolve(parsed.data);
				}).catch((error: unknown) => failReady(error instanceof Error ? error : new Error(String(error))));
			},
			onError: (error) => failReady(error),
		});
		this.runners.set(identity.durableSessionId, { generation, identity: Object.freeze({ ...identity }), runner });
		void runner.observedExit.then((exit: ObservedExit) => {
			const active = this.runners.get(identity.durableSessionId);
			if (active?.runner === runner) {
				this.runners.delete(identity.durableSessionId);
				this.rootEventListeners.delete(identity.durableSessionId);
			}
			if (readySettled) return;
			failReady(exit.kind === "spawn-failure"
				? exit.error
				: new Error(`Runner exited before readiness (code ${exit.code}, signal ${exit.signal})`));
		});
		return {
			ready,
			observedExit: runner.observedExit,
			closeInput: () => runner.closeInput(),
		};
	}
}
