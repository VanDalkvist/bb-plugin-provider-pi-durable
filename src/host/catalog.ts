import { requireExtensionPath } from "./paths.ts";
import { RunnerProcess } from "./runner-process.ts";
import type { AvailableModelDescriptor, ModelScope } from "./types.ts";

export class ModelCatalog {
	private cwd: string;
	private runner: RunnerProcess | null = null;
	private modelScope: ModelScope = {};
	private readyPromise: Promise<void>;
	private readyResolve!: () => void;

	constructor(cwd: string = process.cwd()) {
		this.cwd = cwd;
		this.readyPromise = new Promise((resolve) => {
			this.readyResolve = resolve;
		});
	}

	public async start(): Promise<void> {
		if (this.runner) return;
		const extensionPath = requireExtensionPath();
		this.runner = new RunnerProcess({
			cwd: this.cwd,
			args: ["--mode", "rpc", "--no-session", "--extension", extensionPath],
			onChannelMessage: (msg) => {
				if (msg.kind === "model-scope") {
					this.modelScope = {
						scopedModelIds: msg.scopedModelIds,
						defaultModelId: msg.defaultModelId,
					};
				} else if (msg.kind === "ready") {
					this.readyResolve();
				}
			},
		});

		try {
			await Promise.race([
				this.readyPromise,
				new Promise((_, reject) => setTimeout(() => reject(new Error("Catalog runner startup timed out")), 20000)),
			]);
		} catch (err) {
			console.warn(`[Catalog] Startup ready check timed out or failed: ${err}`);
		}
	}

	public async listModels(): Promise<AvailableModelDescriptor[]> {
		await this.start();
		if (!this.runner) throw new Error("Catalog runner unavailable");

		const raw = await this.runner.requestOk({ type: "get_available_models" });
		const models: any[] = raw?.models ?? [];
		const result: AvailableModelDescriptor[] = [];

		for (const m of models) {
			if (!m.id || !m.provider) continue;
			const fullId = `${m.provider}/${m.id}`;
			const isScoped = !this.modelScope.scopedModelIds || this.modelScope.scopedModelIds.includes(fullId);
			if (!isScoped) continue;

			const isDefault = fullId === this.modelScope.defaultModelId;
			const reasoningEfforts = (m.reasoningEfforts ?? ["low", "medium", "high"]).map((r: string) => ({
				reasoningEffort: r,
				description: `${r.charAt(0).toUpperCase() + r.slice(1)} reasoning effort`,
			}));

			result.push({
				id: fullId,
				model: fullId,
				displayName: `${m.name ?? m.id} (${m.provider})`,
				routeProviderId: m.provider,
				description: `${m.provider} model via Pi Durable`,
				supportedReasoningEfforts: reasoningEfforts,
				defaultReasoningEffort: m.defaultReasoningEffort ?? "medium",
				isDefault,
			});
		}

		if (result.length > 0 && !result.some((m) => m.isDefault)) {
			result[0].isDefault = true;
		}

		return result;
	}

	public async getHealth(): Promise<{ status: "ready" | "unauthenticated" | "unknown"; statusMessage?: string }> {
		try {
			const models = await this.listModels();
			if (models.length > 0) {
				return { status: "ready" };
			}
			return { status: "unauthenticated", statusMessage: "No authenticated models available in Pi." };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { status: "unknown", statusMessage: msg };
		}
	}

	public close(): void {
		if (this.runner) {
			this.runner.kill();
			this.runner = null;
		}
	}
}

let sharedCatalog: ModelCatalog | null = null;
export function getSharedCatalog(cwd?: string): ModelCatalog {
	if (!sharedCatalog) {
		sharedCatalog = new ModelCatalog(cwd);
	}
	return sharedCatalog;
}
