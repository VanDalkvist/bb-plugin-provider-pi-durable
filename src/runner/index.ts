import * as crypto from "node:crypto";
import { writeSync } from "node:fs";
import { Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { type OpenDurableOptions, openDurable } from "./runtime.ts";
import { findInitialAgentModel } from "./harness-setup.ts";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import { BBEventAdapter, type BBWireEvent } from "./bridge/bb-event-adapter.ts";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

interface CliArgs {
	mode?: string;
	session?: string;
	continueSession?: boolean;
	provider?: string;
	model?: string;
	thinking?: ModelThinkingLevel;
	cwd?: string;
	systemPromptPath?: string;
	appendSystemPromptPath?: string;
}

function parseCliArgs(argv: string[]): CliArgs {
	const args: CliArgs = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--mode" && i + 1 < argv.length) args.mode = argv[++i];
		else if (arg === "--session" && i + 1 < argv.length) args.session = argv[++i];
		else if (arg === "--continue") args.continueSession = true;
		else if (arg === "--provider" && i + 1 < argv.length) args.provider = argv[++i];
		else if (arg === "--model" && i + 1 < argv.length) args.model = argv[++i];
		else if (arg === "--thinking" && i + 1 < argv.length) args.thinking = argv[++i] as ModelThinkingLevel;
		else if (arg === "--system-prompt" && i + 1 < argv.length) args.systemPromptPath = argv[++i];
		else if (arg === "--append-system-prompt" && i + 1 < argv.length) args.appendSystemPromptPath = argv[++i];
		else if (!arg.startsWith("-") && !args.cwd) args.cwd = arg;
	}
	return args;
}

const argv = process.argv.slice(2);

// Handle --version flag (Defect D-9)
if (argv.includes("--version") || argv.includes("-v")) {
	console.log("1.0.4");
	process.exit(0);
}

const args = parseCliArgs(argv);

// Write to stdout helper
function output(data: unknown): void {
	process.stdout.write(serializeJsonLine(data));
}

// Side channel setup (FD 3: outbound, FD 4: inbound)
const hasFd3 = Boolean(process.env.BB_PI_BRIDGE_FD3 || process.env.PI_RPC_BRIDGE_CHANNEL);
const sendToBridge = (payload: unknown) => {
	if (!hasFd3) return;
	try {
		writeSync(3, `${JSON.stringify(payload)}\n`);
	} catch {
		// Ignore write errors to closed side channel
	}
};

async function main() {
	const modelRuntime = await ModelRuntime.create();
	const settingsManager = SettingsManager.create(args.cwd ?? process.cwd());

	// Handshake: notify bridge of model scope
	const models = modelRuntime.getAvailableSnapshot();
	const initialAgent = await findInitialAgentModel(
		settingsManager,
		modelRuntime,
		args.model ? { provider: args.provider, model: args.model, thinking: args.thinking } : undefined,
	);

	sendToBridge({
		kind: "model-scope",
		scopedModelIds: models.map((m) => `${m.provider}/${m.id}`),
		defaultModelId: initialAgent.model ? `${initialAgent.model.provider}/${initialAgent.model.modelId}` : undefined,
	});

	// Optional FD 4 inbound channel
	if (process.env.BB_PI_BRIDGE_FD4) {
		try {
			const fd4Socket = new Socket({ fd: 4, readable: true, writable: false });
			attachJsonlLineReader(fd4Socket, (line) => {
				try {
					const msg = JSON.parse(line);
					if (msg?.kind === "ping") sendToBridge({ kind: "pong" });
				} catch {}
			});
		} catch {}
	}

	sendToBridge({ ready: true, kind: "ready" });

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

	// Setup event adapter
	const adapter = new BBEventAdapter((evt: BBWireEvent) => output(evt));

	durable.view.subscribe(() => {
		try {
			adapter.sync(durable.view.current());
		} catch (err) {
			console.error(`Adapter sync error: ${err}`);
		}
	});

	const success = (id: string | undefined, command: string, data?: unknown) => {
		output({ id, type: "response", command, success: true, data });
	};

	const error = (id: string | undefined, command: string, message: string) => {
		output({ id, type: "response", command, success: false, error: message });
	};

	// Handle stdin RPC commands
	attachJsonlLineReader(process.stdin, async (line) => {
		let cmd: any;
		try {
			cmd = JSON.parse(line);
		} catch (e) {
			return;
		}

		if (!cmd || typeof cmd !== "object" || !cmd.type) return;

		switch (cmd.type) {
			case "prompt": {
				if (!cmd.message) {
					error(cmd.id, "prompt", "Missing message");
					return;
				}
				success(cmd.id, "prompt");
				await durable.controller.submit(cmd.message, "steer");
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
				output({ type: "compaction_start", reason: "manual" });
				await durable.controller.compact(cmd.instructions);
				output({ type: "compaction_end", reason: "manual", aborted: false });
				success(cmd.id, "compact");
				break;
			}
			case "get_state": {
				const current = durable.view.current();
				const agentDoc = (current.conversation.docs["pi.agent"] ?? {}) as any;
				success(cmd.id, "get_state", {
					model: agentDoc.model,
					thinkingLevel: agentDoc.thinkingLevel,
					cwd: current.session.cwd,
					sessionId: current.session.id,
				});
				break;
			}
			case "get_session_stats": {
				// Context statistics implementation (defect D-5)
				const current = durable.view.current();
				const usageDoc = (current.conversation.docs["pi.usage"] ?? {}) as any;
				const tokens = usageDoc.totalTokens ?? (usageDoc.input ?? 0) + (usageDoc.output ?? 0);
				const agentDoc = (current.conversation.docs["pi.agent"] ?? {}) as any;
				const modelRef = agentDoc?.model;
				const modelMeta = modelRef ? durable.modelRuntime.getModel(modelRef.provider, modelRef.modelId) : undefined;
				const contextWindow = modelMeta?.contextWindow ?? 1048576;
				success(cmd.id, "get_session_stats", {
					contextUsage: { tokens, contextWindow },
				});
				break;
			}
			case "set_model": {
				const modelsList = durable.modelRuntime.getAvailableSnapshot();
				const target = modelsList.find((m) => m.provider === cmd.provider && m.id === cmd.modelId);
				if (!target) {
					error(cmd.id, "set_model", `Model not found: ${cmd.provider}/${cmd.modelId}`);
					return;
				}
				await durable.controller.setModel({ provider: cmd.provider, modelId: cmd.modelId });
				success(cmd.id, "set_model", target);
				break;
			}
			case "set_thinking_level": {
				// Explicit thinking level setter (defect D-10)
				if (cmd.level) {
					await durable.controller.setThinkingLevel(cmd.level);
				} else {
					await durable.controller.cycleThinking();
				}
				success(cmd.id, "set_thinking_level");
				break;
			}
			case "get_available_models": {
				success(cmd.id, "get_available_models", durable.modelRuntime.getAvailableSnapshot());
				break;
			}
			default: {
				error(cmd.id, cmd.type, `Unknown command: ${cmd.type}`);
				break;
			}
		}
	});

	// Cleanup on SIGINT / SIGTERM
	const cleanup = async () => {
		try {
			await durable.close();
		} finally {
			process.exit(0);
		}
	};
	process.on("SIGINT", cleanup);
	process.on("SIGTERM", cleanup);
}

main().catch((err) => {
	console.error("Durable runner initialization failed:", err);
	process.exit(1);
});
