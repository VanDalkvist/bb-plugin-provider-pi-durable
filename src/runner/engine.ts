import { openDurable } from "./runtime.ts";
import { DurableEventAdapter } from "./bridge/durable-event-adapter.ts";
import { startSubagentWatcher, type SubagentWatcherController } from "./subagent-watcher.ts";
import type { RunnerEvent } from "../contracts/runner-event.ts";

export interface DurableEngineOptions {
	sessionDir?: string;
	session?: string;
	cwd?: string;
	continueSession?: boolean;
	extensions?: string[];
	noGlobalExtensions?: boolean;
}

export class DurableEngine {
	readonly #instance: Awaited<ReturnType<typeof openDurable>>;
	public readonly sessionDir: string;
	private eventListeners = new Set<(event: RunnerEvent) => void>();
	private eventAdapter: DurableEventAdapter;
	private watcher?: SubagentWatcherController;
	private unsubscribeView?: () => void;

	private constructor(
		instance: Awaited<ReturnType<typeof openDurable>>,
		sessionDir: string,
	) {
		this.#instance = instance;
		this.sessionDir = sessionDir;
		this.eventAdapter = new DurableEventAdapter((event) => {
			for (const listener of this.eventListeners) {
				listener(event);
			}
		});
		this.unsubscribeView = this.#instance.view.subscribe(this.eventAdapter.subscriber);
	}

	public static async open(options: DurableEngineOptions = {}): Promise<DurableEngine> {
		const sessionDir = options.sessionDir ?? options.session ?? process.cwd();
		const instance = await openDurable({
			cwd: options.cwd ?? process.cwd(),
			sessionDir,
			session: options.session,
			continueSession: options.continueSession,
			cli: {
				extensions: options.extensions,
				noGlobalExtensions: options.noGlobalExtensions,
			},
		});
		const engine = new DurableEngine(instance, sessionDir);
		engine.watcher = await startSubagentWatcher(
			instance.harness,
			engine.eventAdapter,
			() => instance.view.current(),
		);
		return engine;
	}

	public getSnapshot() {
		return this.#instance.view.current();
	}

	public async prompt(content: string, options?: { deliverAs?: "steer" | "followUp" }): Promise<void> {
		await this.#instance.controller.submit(content, options?.deliverAs ?? "followUp");
	}

	public events(callback: (event: RunnerEvent) => void): () => void {
		this.eventListeners.add(callback);
		return () => this.eventListeners.delete(callback);
	}

	public async abort(): Promise<void> {
		await this.#instance.controller.abort();
	}

	public async close(): Promise<void> {
		this.eventListeners.clear();
		this.unsubscribeView?.();
		this.watcher?.close();
		await this.#instance.close();
	}
}
