import { existsSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Socket } from "node:net";
import { setupRunnerModels } from "./model-setup.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import { openDurable, type OpenDurableOptions, type OpenDurableResult } from "./runtime.ts";
import { ROOT_CONVERSATION_ID, watchEvents } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { BBEventAdapter } from "./bridge/bb-event-adapter.ts";
import type { BBWireEvent } from "./bridge/contracts.ts";
import { type CliArgs, parseCliArgs } from "./cli-args.ts";
import { handleActiveSessionCommand } from "./session-commands.ts";

function getPiDurableVersion(): string {
	try {
		const durablePkg = require.resolve("@earendil-works/pi-durable/package.json");
		if (existsSync(durablePkg)) {
			const parsed = JSON.parse(readFileSync(durablePkg, "utf8"));
			if (parsed.version) return parsed.version;
		}
	} catch {
		// intentionally ignored: package resolution fallback
	}
	try {
		const pluginPkg = join(__dirname, "..", "..", "package.json");
		if (existsSync(pluginPkg)) {
			const parsed = JSON.parse(readFileSync(pluginPkg, "utf8"));
			const dep = parsed.dependencies?.["@earendil-works/pi-durable"]?.replace(/^[\^~]/, "");
			if (dep) return dep;
		}
	} catch {
		// intentionally ignored: package resolution fallback
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
			// intentionally ignored: FD 3 is not open or not writable
		}
	};
} catch {
	// intentionally ignored: bridge channel descriptor setup is optional
}

async function main() {
	let activeDurable: OpenDurableResult | null = null;
	let isTerminating = false;

	const handleExit = async (signalOrReason: string) => {
		if (isTerminating) return;
		isTerminating = true;
		if (activeDurable) {
			try {
				await activeDurable.close();
			} catch (err) {
				console.error(`[Runner] Error releasing durable lock on ${signalOrReason}:`, err);
			}
		}
		process.exit(0);
	};

	process.on("SIGTERM", () => { void handleExit("SIGTERM"); });
	process.on("SIGINT", () => { void handleExit("SIGINT"); });
	process.stdin.on("end", () => { void handleExit("stdin.end"); });

	const cwd = args.cwd ?? process.cwd();
	const {
		modelRuntime,
		scopedModelList,
		defaultModel,
		defaultThinkingLevel,
		modelScope,
	} = await setupRunnerModels(cwd, args);

	// Notify bridge of model scope over FD 3
	sendToBridge({ kind: "model-scope", ...modelScope });

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
		sendToBridge({ ready: true, kind: "ready" });
		attachJsonlLineReader(process.stdin, (line) => {
			if (!line.trim()) return;
			try {
				const cmd = JSON.parse(line);
				if (cmd.type === "get_available_models") {
					success(cmd.id, "get_available_models", { models: scopedModelList });
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
	activeDurable = durable;

	// Setup native Pi Durable event stream adapter
	const adapter = new BBEventAdapter(
		(evt: BBWireEvent) => output(evt),
		(provider, modelId) => {
			const p = provider ?? args.provider;
			const m = modelId ?? args.model;
			return p && m ? modelRuntime.getModel(p, m)?.contextWindow : undefined;
		},
	);
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

		try {
			await handleActiveSessionCommand(cmd, durable, modelRuntime, args, { success, error });
		} catch (err) {
			error(cmd.id, cmd.type, err instanceof Error ? err.message : String(err));
		}
	});

	// Signal active session readiness only after SQLite store, event stream and stdin listener are active
	sendToBridge({ ready: true, kind: "ready" });
}

main().catch((err) => {
	console.error(`Runner fatal error: ${err instanceof Error ? err.stack : err}`);
	process.exit(1);
});
