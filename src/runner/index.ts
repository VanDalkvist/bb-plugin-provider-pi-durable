export { DurableEngine, type DurableEngineOptions } from "./engine.ts";
import { setupRunnerModels } from "./model-setup.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import { openDurable } from "./runtime.ts";
import type { OpenDurableOptions, OpenDurableResult } from "./runtime-types.ts";
import { DurableEventAdapter } from "./bridge/durable-event-adapter.ts";
import type { RunnerEvent } from "./bridge/contracts.ts";
import { parseCliArgs } from "./cli-args.ts";
import { handleActiveSessionCommand } from "./session-commands.ts";
import { parseRunnerCommand, type RunnerCommandPayload } from "../contracts/runner-command.ts";
import { getPiDurableVersion } from "./version.ts";
import { createBridgeSender, initBridgeInboundChannel, createForwardToolCall, createRequestInteraction } from "./bridge-channel.ts";
import { startSubagentWatcher, type SubagentWatcherController } from "./subagent-watcher.ts";
import { RuntimeGraphSource } from "./runtime-graph-source.ts";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { setupRunnerStdoutGuard, writeWireStdout, flushWireStdout } from "./stdout-guard.ts";
import { startRunnerControlChannel, type ControlChannelController } from "./control-channel.ts";

const argv = process.argv.slice(2);

// Handle --version flag dynamically (Defect D-9, AP-027)
if (argv.includes("--version") || argv.includes("-v")) {
	console.log(getPiDurableVersion());
	process.exit(0);
}

const args = parseCliArgs(argv);

function output(data: unknown): void {
	writeWireStdout(serializeJsonLine(data));
}

const sendToBridge = createBridgeSender();
const forwardToolCall = createForwardToolCall(sendToBridge);
const requestInteraction = createRequestInteraction(sendToBridge);

async function main() {
	await setupRunnerStdoutGuard();

	let activeDurable: OpenDurableResult | null = null;
	let activeWatcher: SubagentWatcherController | null = null;
	let activeGraphSource: RuntimeGraphSource | null = null;
	let activeControlChannel: ControlChannelController | null = null;
	let isTerminating = false;

	const handleExit = async (signalOrReason: string) => {
		if (isTerminating) return;
		isTerminating = true;
		try { activeControlChannel?.close(); } catch (err) {
			console.warn(`[Runner] Error closing control channel on ${signalOrReason}: ${err instanceof Error ? err.message : String(err)}`);
		}
		try { activeGraphSource?.teardown(); } catch (err) {
			console.warn(`[Runner] Error tearing down graph source on ${signalOrReason}: ${err instanceof Error ? err.message : String(err)}`);
		}
		try { activeWatcher?.close(); } catch (err) {
			console.warn(`[Runner] Error closing subagent watcher on ${signalOrReason}: ${err instanceof Error ? err.message : String(err)}`);
		}
		try { await activeDurable?.close(); } catch (err) {
			console.error(`[Runner] Error releasing durable lock on ${signalOrReason}:`, err);
		}
		try { await flushWireStdout(); } catch (err) {
			console.warn(`[Runner] Error flushing stdout on ${signalOrReason}: ${err instanceof Error ? err.message : String(err)}`);
		}
		process.exit(0);
	};

	for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { void handleExit(sig); });
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
	initBridgeInboundChannel(modelScope, sendToBridge);

	const success = (id: string | undefined, command: string, data?: unknown) => {
		output({ id, type: "response", command, success: true, data });
	};

	const error = (id: string | undefined, command: string, message: string) => {
		output({ id, type: "response", command, success: false, error: message });
	};

	// Handle probe / catalog mode (--no-session)
	if (args.noSession) {
		output({ type: "ready", kind: "ready", pid: process.pid });
		sendToBridge({ ready: true, kind: "ready", pid: process.pid });
		attachJsonlLineReader(process.stdin, (line) => {
			if (!line.trim()) return;
			try {
				const cmd = parseRunnerCommand(line);
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
				error(undefined, "unknown", "INVALID_COMMAND");
			}
		});
		return;
	}

	const durable = await openDurable({
		cwd: args.cwd,
		continueSession: args.continueSession,
		session: args.session,
		cli: { provider: args.provider, model: args.model, thinking: args.thinking, skills: args.skills, extension: args.extension },
		prompt: { systemPromptPath: args.systemPromptPath, appendSystemPromptPath: args.appendSystemPromptPath },
		toolsFilePath: args.toolsFilePath,
		forwardToolCall,
		requestInteraction,
	});
	activeDurable = durable;
	activeControlChannel = startRunnerControlChannel(durable.view.current().session.directory, durable.harness);

	// Setup native Pi Durable event stream adapter with subagent multiplexing
	const adapter = new DurableEventAdapter(
		(evt: RunnerEvent) => output(evt),
		(provider, modelId) => {
			const p = provider ?? args.provider;
			const m = modelId ?? args.model;
			return p && m ? modelRuntime.getModel(p, m)?.contextWindow : undefined;
		},
	);
	const watcher = await startSubagentWatcher(durable.harness, adapter, () => durable.view.current());
	activeWatcher = watcher; durable.watcher = watcher;
	activeGraphSource = new RuntimeGraphSource(
		durable.view,
		{
			sessionId: durable.view.current().session.id,
			rootConversationId: String(ROOT_CONVERSATION_ID),
			buildId: "pi-durable-1.4",
		},
		{
			harness: durable.harness,
		},
	);
	activeGraphSource.subscribe((snapshot) => output({ type: "runtime_graph_snapshot", snapshot }));

	// Handle stdin RPC commands in active session with sequential FIFO queue
	let stdinQueue = Promise.resolve();
	attachJsonlLineReader(process.stdin, (line) => {
		stdinQueue = stdinQueue.then(async () => {
			let cmd: RunnerCommandPayload;
			try {
				cmd = parseRunnerCommand(line);
			} catch (e) {
				error(undefined, "parse", "INVALID_COMMAND");
				return;
			}

			try {
				await handleActiveSessionCommand(cmd, durable, modelRuntime, args, { success, error });
			} catch (err) {
				error(cmd.id, cmd.type ?? "unknown", err instanceof Error ? err.message : String(err));
			}
		}).catch((fatal) => {
			console.error(`[Runner stdin] Unhandled command error: ${fatal}`);
		});
	});

	// Signal active session readiness only after SQLite store, event stream and stdin listener are active
	output({ type: "ready", kind: "ready", pid: process.pid });
	sendToBridge({ ready: true, kind: "ready", pid: process.pid });
}

main().catch((err) => {
	console.error(`Runner fatal error: ${err instanceof Error ? err.stack : err}`);
	process.exit(1);
});
