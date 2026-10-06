import { existsSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Socket } from "node:net";
import { DefaultResourceLoader, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "./sessions.ts";
import type { ModelThinkingLevel } from "./harness-setup.ts";
import { findInitialAgentModel } from "./harness-setup.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import { openDurable, type OpenDurableOptions } from "./runtime.ts";
import { ROOT_CONVERSATION_ID, watchEvents } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { BBEventAdapter } from "./bridge/bb-event-adapter.ts";
import type { BBWireEvent } from "./bridge/contracts.ts";

export interface CliArgs {
	mode?: string;
	session?: string;
	continueSession?: boolean;
	noSession?: boolean;
	provider?: string;
	model?: string;
	thinking?: ModelThinkingLevel;
	cwd?: string;
	systemPromptPath?: string;
	appendSystemPromptPath?: string;
	extension?: string;
}

function parseCliArgs(argv: string[]): CliArgs {
	const args: CliArgs = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--mode" && i + 1 < argv.length) args.mode = argv[++i];
		else if (arg === "--session" && i + 1 < argv.length) args.session = argv[++i];
		else if (arg === "--continue") args.continueSession = true;
		else if (arg === "--no-session") args.noSession = true;
		else if (arg === "--provider" && i + 1 < argv.length) args.provider = argv[++i];
		else if (arg === "--model" && i + 1 < argv.length) args.model = argv[++i];
		else if (arg === "--thinking" && i + 1 < argv.length) args.thinking = argv[++i] as ModelThinkingLevel;
		else if (arg === "--system-prompt" && i + 1 < argv.length) args.systemPromptPath = argv[++i];
		else if (arg === "--append-system-prompt" && i + 1 < argv.length) args.appendSystemPromptPath = argv[++i];
		else if (arg === "--extension" && i + 1 < argv.length) args.extension = argv[++i];
		else if (!arg.startsWith("-") && !args.cwd) args.cwd = arg;
	}
	return args;
}

function getPiDurableVersion(): string {
	try {
		const durablePkg = require.resolve("@earendil-works/pi-durable/package.json");
		if (existsSync(durablePkg)) {
			const parsed = JSON.parse(readFileSync(durablePkg, "utf8"));
			if (parsed.version) return parsed.version;
		}
	} catch {
		// fallback
	}
	try {
		const pluginPkg = join(__dirname, "..", "..", "package.json");
		if (existsSync(pluginPkg)) {
			const parsed = JSON.parse(readFileSync(pluginPkg, "utf8"));
			const dep = parsed.dependencies?.["@earendil-works/pi-durable"]?.replace(/^[\^~]/, "");
			if (dep) return dep;
		}
	} catch {
		// fallback
	}
	return "1.0.0";
}

const argv = process.argv.slice(2);

// Handle --version flag dynamically (Defect D-9, AP-027)
if (argv.includes("--version") || argv.includes("-v")) {
	console.log(getPiDurableVersion());
	process.exit(0);
}

const args = parseCliArgs(argv);

// Write to stdout helper
function output(data: unknown): void {
	process.stdout.write(serializeJsonLine(data));
}

const CHILD_TO_BRIDGE_FD = 3;
const BRIDGE_TO_CHILD_FD = 4;

let sendToBridge = (_msg: unknown) => {};
try {
	sendToBridge = (msg: unknown) => {
		const str = `${JSON.stringify(msg)}\n`;
		try {
			writeSync(CHILD_TO_BRIDGE_FD, Buffer.from(str, "utf8"));
		} catch {
			// Ignore write error if FD 3 is not open
		}
	};
} catch {}

async function main() {
	process.on("SIGTERM", () => process.exit(0));
	process.on("SIGINT", () => process.exit(0));
	process.stdin.on("end", () => process.exit(0));

	const cwd = args.cwd ?? process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const modelRuntime = await ModelRuntime.create();

	// Load extensions and providers (Antigravity, OpenRouter, etc.)
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
	await resourceLoader.reload();
	const extensionsResult = resourceLoader.getExtensions();
	for (const { name, config } of extensionsResult.runtime.pendingProviderRegistrations) {
		try {
			modelRuntime.registerProvider(name, config);
		} catch {
			// intentionally ignored: provider registration may already exist or fail gracefully
		}
	}
	for (const { provider } of extensionsResult.runtime.pendingNativeProviderRegistrations) {
		try {
			modelRuntime.registerNativeProvider(provider);
		} catch {
			// intentionally ignored: native provider may already be registered
		}
	}
	for (const { definition } of extensionsResult.runtime.pendingVirtualModelRegistrations) {
		try {
			modelRuntime.registerVirtualModel(definition);
		} catch {
			// intentionally ignored: virtual model may already be registered
		}
	}

	// Models discovery
	const availableModels = modelRuntime.getAvailableSnapshot();
	const initialAgent = await findInitialAgentModel(
		settingsManager,
		modelRuntime,
		args.model ? { provider: args.provider, model: args.model, thinking: args.thinking } : undefined,
	);

	const defaultModel = initialAgent.model
		? modelRuntime.getModel(initialAgent.model.provider, initialAgent.model.modelId) ?? availableModels[0]
		: availableModels[0];
	const defaultModelId = defaultModel ? `${defaultModel.provider}/${defaultModel.id}` : undefined;
	const defaultThinkingLevel = initialAgent.thinkingLevel ?? "off";

	const modelScope = {
		scopedModelIds: availableModels.map((m) => `${m.provider}/${m.id}`),
		defaultModelId,
	};

	// Notify bridge of model scope and ready status over FD 3
	sendToBridge({ kind: "model-scope", ...modelScope });
	sendToBridge({ ready: true, kind: "ready" });

	// Inbound side channel on FD 4
	try {
		const bridgeIn = new Socket({ fd: BRIDGE_TO_CHILD_FD, readable: true, writable: false });
		bridgeIn.on("error", () => {});
		bridgeIn.unref();

		attachJsonlLineReader(bridgeIn, (line) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			try {
				const req = JSON.parse(trimmed);
				if (req.kind === "request") {
					if (req.method === "model-scope") {
						sendToBridge({ kind: "reply", id: req.id, result: modelScope });
					} else if (req.method === "refresh-models") {
						sendToBridge({ kind: "reply", id: req.id, result: { refreshed: true } });
					} else if (req.method === "leaf") {
						sendToBridge({ kind: "reply", id: req.id, result: { leafId: null } });
					} else {
						sendToBridge({ kind: "reply", id: req.id, result: {} });
					}
				}
			} catch (err) {
				console.error("[Runner] Failed to parse or process bridge channel message:", err);
			}
		});
	} catch {
		// intentionally ignored: FD 4 is not open when running without parent bridge channel
	}

	const success = (id: string | undefined, command: string, data?: unknown) => {
		output({ id, type: "response", command, success: true, data });
	};

	const error = (id: string | undefined, command: string, message: string) => {
		output({ id, type: "response", command, success: false, error: message });
	};

	// Handle probe / catalog mode (--no-session)
	if (args.noSession) {
		attachJsonlLineReader(process.stdin, (line) => {
			if (!line.trim()) return;
			try {
				const cmd = JSON.parse(line);
				if (cmd.type === "get_available_models") {
					const currentModels = modelRuntime.getAvailableSnapshot();
					success(cmd.id, "get_available_models", { models: currentModels });
				} else if (cmd.type === "get_state") {
					success(cmd.id, "get_state", {
						model: defaultModel ? { provider: defaultModel.provider, id: defaultModel.id, modelId: defaultModel.id } : null,
						thinkingLevel: defaultThinkingLevel,
						isStreaming: false,
						isCompacting: false,
						steeringMode: "one-at-a-time",
						followUpMode: "one-at-a-time",
						sessionId: "catalog",
						autoCompactionEnabled: true,
						messageCount: 0,
						pendingMessageCount: 0,
					});
				} else {
					success(cmd.id, cmd.type, {});
				}
			} catch (err) {
				error(undefined, "unknown", err instanceof Error ? err.message : String(err));
			}
		});
		return;
	}

	// Active durable session mode
	const durableOptions: OpenDurableOptions = {
		cwd: args.cwd,
		continueSession: args.continueSession,
		session: args.session,
		cli: args.model ? { provider: args.provider, model: args.model, thinking: args.thinking } : undefined,
		prompt: {
			systemPromptPath: args.systemPromptPath,
			appendSystemPromptPath: args.appendSystemPromptPath,
		},
	};

	const durable = await openDurable(durableOptions);

	// Setup native Pi Durable event stream adapter
	const adapter = new BBEventAdapter((evt: BBWireEvent) => output(evt));
	const stream = await watchEvents(durable.harness, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
	stream.start(async (batch) => {
		try {
			for (const event of batch) {
				adapter.handleEvent(event, durable.view.current());
			}
		} catch (err) {
			console.error(`Adapter stream error: ${err}`);
		}
	});

	// Handle stdin RPC commands in active session
	attachJsonlLineReader(process.stdin, async (line) => {
		let cmd: any;
		try {
			cmd = JSON.parse(line);
		} catch (e) {
			error(undefined, "parse", `Invalid JSON: ${e}`);
			return;
		}

		switch (cmd.type) {
			case "prompt": {
				if (!cmd.message) {
					error(cmd.id, "prompt", "Missing message");
					return;
				}
				success(cmd.id, "prompt");
				const behavior = (cmd.streamingBehavior as "steer" | "followUp") || "followUp";
				await durable.controller.submit(cmd.message, behavior);
				break;
			}
			case "steer": {
				if (!cmd.message) {
					error(cmd.id, "steer", "Missing message");
					return;
				}
				success(cmd.id, "steer");
				await durable.controller.submit(cmd.message, "steer");
				break;
			}
			case "abort": {
				await durable.controller.abort();
				success(cmd.id, "abort");
				break;
			}
			case "compact": {
				await durable.controller.compact(cmd.instructions);
				success(cmd.id, "compact");
				break;
			}
			case "get_state": {
				const current = durable.view.current();
				const agentDoc = (current.conversation.docs["pi.agent"] ?? {}) as any;
				const modelObj = agentDoc.model
					? {
							provider: agentDoc.model.provider,
							id: agentDoc.model.id ?? agentDoc.model.modelId,
							modelId: agentDoc.model.modelId ?? agentDoc.model.id,
						}
					: null;
				success(cmd.id, "get_state", {
					model: modelObj,
					thinkingLevel: agentDoc.thinkingLevel ?? "none",
					cwd: args.cwd ?? process.cwd(),
					sessionId: args.session ?? "default",
				});
				break;
			}
			case "get_available_models": {
				const currentModels = modelRuntime.getAvailableSnapshot();
				success(cmd.id, "get_available_models", { models: currentModels });
				break;
			}
			case "set_model": {
				if (!cmd.provider || !cmd.modelId) {
					error(cmd.id, "set_model", "Missing provider or modelId");
					return;
				}
				await durable.controller.setModel({ provider: cmd.provider, modelId: cmd.modelId });
				success(cmd.id, "set_model");
				break;
			}
			case "set_thinking_level": {
				await durable.controller.setThinkingLevel(cmd.level);
				success(cmd.id, "set_thinking_level");
				break;
			}
			case "get_session_stats": {
				const current = durable.view.current();
				const agentDoc = (current.conversation.docs["pi.agent"] ?? {}) as any;
				let contextWindow = 128000;
				if (agentDoc.model?.provider && agentDoc.model?.modelId) {
					const m = modelRuntime.getModel(agentDoc.model.provider, agentDoc.model.modelId);
					if (m?.contextWindow) contextWindow = m.contextWindow;
				}
				let tokens: number | null = null;
				try {
					const conv = await durable.harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
					if (conv) {
						const ctxView = await conv.context(BACKGROUND_CONTEXT);
						const estimate = estimateContextTokens(ctxView.messages);
						tokens = estimate.tokens;
					}
				} catch (err) {
					console.error(`Error estimating context tokens: ${err}`);
				}
				success(cmd.id, "get_session_stats", {
					contextUsage: {
						tokens,
						contextWindow,
					},
				});
				break;
			}
			default: {
				error(cmd.id, cmd.type, `Unknown command: ${cmd.type}`);
				break;
			}
		}
	});
}

main().catch((err) => {
	console.error(`Runner fatal error: ${err instanceof Error ? err.stack : err}`);
	process.exit(1);
});
