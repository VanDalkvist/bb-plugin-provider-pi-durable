import { StringDecoder } from "node:string_decoder";
import { runnerCommandSchema, runnerRequestHeaderSchema, knownCommandTypes } from "../contracts/runner-command.ts";
import type { RunnerEvent } from "../contracts/runner-event.ts";
import type { RunnerResponse } from "../contracts/runner-response.ts";
import type { RunnerChannelFrame } from "../contracts/runner-channel.ts";
import { decodeStdout, decodeChannel, parseProtocolJson, RunnerProtocolError } from "./runner-protocol-error.ts";

export interface PendingRequest {
	command: string;
	resolve: (val: unknown) => void;
	reject: (err: Error) => void;
	timer?: NodeJS.Timeout;
}

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export class RunnerRpcChannel {
	public pendingRequests = new Map<string, PendingRequest>();
	private nextRequestId = 0;
	private stdoutDecoder = new StringDecoder("utf8");
	private stdoutBuf = "";
	private channelDecoder = new StringDecoder("utf8");
	private channelBuf = "";
	private fault?: RunnerProtocolError;
	private unknownCount = 0;

	private readonly onFault?: (error: RunnerProtocolError) => void;
	constructor(onFault?: (error: RunnerProtocolError) => void) { this.onFault = onFault; }
	public get protocolError(): RunnerProtocolError | undefined { return this.fault; }

	public feedStdout(chunk: Buffer, onEvent: (event: RunnerEvent) => void): void {
		if (this.fault) return;
		this.stdoutBuf += this.stdoutDecoder.write(chunk);
		const lines = this.stdoutBuf.split("\n");
		this.stdoutBuf = lines.pop() ?? "";
		if (Buffer.byteLength(this.stdoutBuf) > MAX_FRAME_BYTES) return this.failProtocol(new RunnerProtocolError("FRAME_TOO_LARGE"));
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				this.checkLength(line);
				const parsed = decodeStdout(parseProtocolJson(line));
				if (!parsed) { this.unknown(); continue; }
				if (!this.handleIncoming(parsed) && parsed.type !== "response") onEvent(parsed);
			} catch (cause) {
				return this.failProtocol(cause instanceof RunnerProtocolError ? cause : new RunnerProtocolError("CONSUMER_FAILURE", cause));
			}
		}
	}

	public feedChannel(chunk: Buffer, onMessage: (msg: RunnerChannelFrame) => void): void {
		if (this.fault) return;
		this.channelBuf += this.channelDecoder.write(chunk);
		const lines = this.channelBuf.split("\n");
		this.channelBuf = lines.pop() ?? "";
		if (Buffer.byteLength(this.channelBuf) > MAX_FRAME_BYTES) return this.failProtocol(new RunnerProtocolError("FRAME_TOO_LARGE"));
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				this.checkLength(line);
				const parsed = decodeChannel(parseProtocolJson(line));
				if (parsed) onMessage(parsed); else this.unknown();
			} catch (cause) {
				return this.failProtocol(cause instanceof RunnerProtocolError ? cause : new RunnerProtocolError("CONSUMER_FAILURE", cause));
			}
		}
	}

	public createRequest(cmd: Record<string, unknown>, timeoutMs: number, sendJson: (payload: Record<string, unknown>) => void): Promise<unknown> {
		if (this.fault) return Promise.reject(this.fault);
		const schema = typeof cmd.type === "string" && knownCommandTypes.has(cmd.type) ? runnerCommandSchema : runnerRequestHeaderSchema;
		const parsed = schema.safeParse(cmd);
		if (!parsed.success) return Promise.reject(new RunnerProtocolError("INVALID_MESSAGE", parsed.error));
		const id = `req_${++this.nextRequestId}`;
		const command = parsed.data.type;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Runner request timed out (${timeoutMs}ms)`));
			}, timeoutMs);
			this.pendingRequests.set(id, { command, resolve, reject, timer });
			try { sendJson({ ...parsed.data, id }); }
			catch (cause) { this.failProtocol(new RunnerProtocolError("CONSUMER_FAILURE", cause)); }
		});
	}

	public handleIncoming(msg: RunnerEvent | RunnerResponse): boolean {
		if (msg.type !== "response") return false;
		if (msg.id === undefined) {
			if (this.pendingRequests.size > 0) throw new RunnerProtocolError("INVALID_MESSAGE");
			return true;
		}
		const pending = this.pendingRequests.get(msg.id);
		if (!pending) return true;
		if (msg.command !== pending.command) throw new RunnerProtocolError("MISMATCHED_RESPONSE");
		if (pending.timer) clearTimeout(pending.timer);
		this.pendingRequests.delete(msg.id);
		if (!msg.success) pending.reject(new Error(msg.error));
		else pending.resolve(msg.data);
		return true;
	}

	public failProtocol(error: RunnerProtocolError): void {
		if (this.fault) return;
		this.fault = error;
		this.stdoutBuf = ""; this.channelBuf = "";
		this.failAll(error);
		console.error(JSON.stringify({ component: "RunnerRpcChannel", event: "protocol_fault", severity: "error", outcome: "failed", code: error.code }));
		if (this.onFault) this.onFault(error); else throw error;
	}

	public failAll(error: Error): void {
		for (const { reject, timer } of this.pendingRequests.values()) {
			if (timer) clearTimeout(timer);
			reject(error);
		}
		this.pendingRequests.clear();
	}

	private checkLength(line: string): void {
		if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new RunnerProtocolError("FRAME_TOO_LARGE");
	}

	private unknown(): void {
		if (this.unknownCount++ < 3) console.warn(JSON.stringify({ component: "RunnerRpcChannel", event: "unknown_message", severity: "info", outcome: "skipped" }));
	}
}
