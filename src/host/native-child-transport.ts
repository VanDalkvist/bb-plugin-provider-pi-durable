import { randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { RedemptionIdentitySchema } from "../native-child-contract.ts";

export const MAX_NATIVE_CHILD_FRAME_BYTES = 64 * 1024;
const requestSchema = z.object({
	id: z.string().min(1).max(128),
	credential: z.string().min(1).max(256),
	expected: RedemptionIdentitySchema,
	command: z.discriminatedUnion("type", [
		z.object({ type: z.literal("bootstrap-ack"), requestId: z.string().min(1).max(512) }).strict(),
		z.object({ type: z.literal("view-attach") }).strict(),
		z.object({ type: z.literal("child-stop") }).strict(),
		z.object({
			type: z.literal("root-configure"),
			launch: z.object({
				cwd: z.string().min(1).max(4096),
				model: z.object({ provider: z.string().min(1).max(512), modelId: z.string().min(1).max(512) }).strict(),
				thinking: z.string().min(1).max(128),
				appendSystemPrompt: z.string().min(1).max(16384).optional(),
				environment: z.record(z.string().min(1).max(256), z.string().max(8192)).refine((env) => Object.keys(env).length <= 256),
			}).strict(),
		}).strict(),
		z.object({ type: z.literal("root"), command: z.discriminatedUnion("type", [
			z.object({ type: z.literal("prompt"), message: z.string().max(32_000) }).strict(),
			z.object({ type: z.literal("steer"), message: z.string().max(32_000) }).strict(),
			z.object({ type: z.literal("abort") }).strict(),
			z.object({ type: z.literal("set_model"), provider: z.string().min(1).max(512), modelId: z.string().min(1).max(512) }).strict(),
			z.object({ type: z.literal("set_thinking_level"), level: z.string().min(1).max(128) }).strict(),
			z.object({ type: z.literal("get_session_stats") }).strict(),
			z.object({ type: z.literal("compact"), instructions: z.string().max(32_000).optional() }).strict(),
		]) }).strict(),
	]),
}).strict().refine((request) => request.command.type !== "root-configure" || request.expected.kind === "ordinary-root");

export const RootConfigureResponseSchema = z.object({ accepted: z.literal(true), generation: z.number().int().safe().nonnegative() }).strict();
export type NativeChildTransportRequest = z.infer<typeof requestSchema>;
export type NativeChildTransportResponse = { id: string; ok: true; data?: unknown } | { id: string; ok: false; error: "denied" | "invalid_frame" };
export type NativeChildTransportEvent = { type: "event"; data: unknown };
const responseSchema = z.discriminatedUnion("ok", [
	z.object({ id: z.string().min(1).max(128), ok: z.literal(true), data: z.unknown().optional() }).strict(),
	z.object({ id: z.string().min(1).max(128), ok: z.literal(false), error: z.enum(["denied", "invalid_frame"]) }).strict(),
]);
const eventSchema = z.object({ type: z.literal("event"), data: z.unknown() }).strict();
const chunkSchema = z.object({ type: z.literal("event-chunk"), id: z.string().uuid(), index: z.number().int().nonnegative(), final: z.boolean(), data: z.string() }).strict();
const EVENT_CHUNK_BYTES = 24 * 1024;

function sendEvent(socket: NativeChildTransportConnection, event: unknown): void {
	const encoded = Buffer.from(JSON.stringify({ type: "event", data: event } satisfies NativeChildTransportEvent));
	if (encoded.byteLength + 1 <= MAX_NATIVE_CHILD_FRAME_BYTES) { socket.write(`${encoded.toString("utf8")}\n`); return; }
	const id = randomUUID();
	for (let offset = 0, index = 0; offset < encoded.byteLength; offset += EVENT_CHUNK_BYTES, index++) {
		const data = encoded.subarray(offset, offset + EVENT_CHUNK_BYTES).toString("base64");
		socket.write(`${JSON.stringify({ type: "event-chunk", id, index, final: offset + EVENT_CHUNK_BYTES >= encoded.byteLength, data })}\n`);
	}
}
export type NativeChildTransportHandler = (request: NativeChildTransportRequest) => Promise<unknown>;
export type NativeChildViewAttacher = (request: NativeChildTransportRequest, emit: (event: unknown) => void, signal: AbortSignal) => Promise<() => void>;
export interface NativeChildViewClient {
	request(command: NativeChildTransportRequest["command"]): Promise<unknown>;
	attachRootView(onEvent: (event: unknown) => void, onDisconnect?: (reason: "closed" | "error") => void): Promise<() => void>;
}
export interface NativeChildTransportClientConnection extends NativeChildTransportConnection {}
export interface NativeChildTransportConnection {
	on(event: "data", listener: (chunk: Buffer) => void): this;
	on(event: "close", listener: () => void): this;
	on(event: "connect", listener: () => void): this;
	on(event: "end", listener: () => void): this;
	on(event: "error", listener: (error: Error) => void): this;
	write(data: string): boolean;
	end(): void;
	destroy(): void;
}
export interface NativeChildTransportServer {
	on(event: "error", listener: (error: Error) => void): this;
	listen(endpoint: string, listener: () => void): this;
	close(callback?: (error?: Error) => void): this;
}
export type NativeChildTransportOptions = {
	endpoint: string;
	handle: NativeChildTransportHandler;
	createServer?: (onConnection: (socket: NativeChildTransportConnection) => void) => NativeChildTransportServer;
	setPermissions?: (endpoint: string) => Promise<void>;
	attachView?: NativeChildViewAttacher;
	maxPeers?: number;
	preAuthTimeoutMs?: number;
};

export class NativeChildFrameDecoder {
	private readonly decoder = new StringDecoder("utf8");
	private buffered = "";
	private failed = false;

	feed(chunk: Buffer): Array<{ value: unknown } | { error: "invalid_frame" }> {
		if (this.failed) return [];
		this.buffered += this.decoder.write(chunk);
		const lines = this.buffered.split("\n");
		this.buffered = lines.pop() ?? "";
		const frames: Array<{ value: unknown } | { error: "invalid_frame" }> = [];
		if (Buffer.byteLength(this.buffered, "utf8") > MAX_NATIVE_CHILD_FRAME_BYTES) {
			this.failed = true;
			this.buffered = "";
			return [{ error: "invalid_frame" }];
		}
		for (const line of lines) {
			if (Buffer.byteLength(line, "utf8") > MAX_NATIVE_CHILD_FRAME_BYTES) {
				frames.push({ error: "invalid_frame" });
				this.failed = true;
				break;
			}
			try { frames.push({ value: JSON.parse(line) as unknown }); }
			catch { frames.push({ error: "invalid_frame" }); }
		}
		return frames;
	}

	finish(): boolean {
		this.buffered += this.decoder.end();
		const incomplete = this.buffered.length > 0 || Buffer.byteLength(this.buffered, "utf8") > MAX_NATIVE_CHILD_FRAME_BYTES;
		this.buffered = "";
		return !incomplete;
	}
}

function send(socket: NativeChildTransportConnection, response: NativeChildTransportResponse): void {
	try {
		const frame = `${JSON.stringify(response)}\n`;
		if (Buffer.byteLength(frame, "utf8") > MAX_NATIVE_CHILD_FRAME_BYTES) { socket.destroy(); return; }
		socket.write(frame);
	} catch { socket.destroy(); }
}

export class NativeChildTransportServerAdapter {
	private readonly options: NativeChildTransportOptions;
	private server?: NativeChildTransportServer;
	private startup?: Promise<void>;
	private closePromise?: Promise<void>;
	private readonly peers = new Set<NativeChildTransportConnection>();
	private closed = false;

	constructor(options: NativeChildTransportOptions) { this.options = options; }

	start(): Promise<void> {
		if (this.closePromise) return Promise.reject(new Error("Native child transport is closed"));
		if (this.startup) return this.startup;
		if (this.closed) return Promise.reject(new Error("Native child transport is closed"));
		if (this.server) return Promise.resolve();
		const server = (this.options.createServer ?? ((onConnection) => createServer((socket) => onConnection(socket))))((socket) => this.accept(socket));
		this.server = server;
		this.startup = new Promise<void>((resolve, reject) => {
			let settled = false;
			const fail = (error: Error): void => {
				if (settled) return;
				settled = true;
				this.closed = true;
				this.server = undefined;
				for (const peer of this.peers) peer.destroy();
				this.peers.clear();
				server.close(() => reject(error));
			};
			server.on("error", fail);
			server.listen(this.options.endpoint, () => {
				if (this.closed) { fail(new Error("Native child transport closed during startup")); return; }
				void (this.options.setPermissions ?? ((endpoint) => chmod(endpoint, 0o600)))(this.options.endpoint).then(() => {
					if (settled) return;
					if (this.closed) { fail(new Error("Native child transport closed during startup")); return; }
					settled = true;
					resolve();
				}, (error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
			});
		});
		return this.startup;
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closed = true;
		this.closePromise = (async () => {
			try { await this.startup; } catch { return; }
			const server = this.server;
			this.server = undefined;
			for (const peer of this.peers) peer.destroy();
			this.peers.clear();
			if (server) await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));
		})();
		return this.closePromise;
	}

	private accept(socket: NativeChildTransportConnection): void {
		if (this.closed || this.peers.size >= (this.options.maxPeers ?? 64)) { socket.destroy(); return; }
		this.peers.add(socket);
		socket.on("close", () => this.peers.delete(socket));
		const authTimer = setTimeout(() => socket.destroy(), this.options.preAuthTimeoutMs ?? 5_000);
		let peerClosed = false;
		let detachView: (() => void) | undefined;
		const peerAbort = new AbortController();
		const closePeer = (): void => {
			peerClosed = true;
			peerAbort.abort();
			clearTimeout(authTimer);
			detachView?.();
			detachView = undefined;
		};
		socket.on("close", closePeer);
		socket.on("end", closePeer);
		const decoder = new NativeChildFrameDecoder();
		let settled = false;
		const deny = (id = "invalid"): void => {
			if (settled) { socket.destroy(); return; }
			settled = true;
			clearTimeout(authTimer);
			send(socket, { id, ok: false, error: "invalid_frame" });
			socket.end();
		};
		socket.on("data", (chunk: Buffer) => {
			for (const frame of decoder.feed(chunk)) {
				if ("error" in frame) { deny(); return; }
				const parsed = requestSchema.safeParse(frame.value);
				if (!parsed.success || settled) { deny(parsed.success ? parsed.data.id : "invalid"); return; }
				settled = true;
				clearTimeout(authTimer);
				if (parsed.data.command.type === "view-attach") {
					if (!this.options.attachView) { deny(parsed.data.id); return; }
					void this.options.attachView(parsed.data, (event) => {
						if (peerClosed) return;
						try { sendEvent(socket, event); } catch { socket.destroy(); }
					}, peerAbort.signal).then((detach) => {
						detachView = detach;
						if (peerClosed) { detachView(); detachView = undefined; return; }
						send(socket, { id: parsed.data.id, ok: true, data: { attached: true } });
					}).catch(() => {
						send(socket, { id: parsed.data.id, ok: false, error: "denied" });
						socket.end();
					});
					return;
				}
				void this.options.handle(parsed.data).then((data) => {
					send(socket, { id: parsed.data.id, ok: true, data });
					socket.end();
				}).catch(() => {
					send(socket, { id: parsed.data.id, ok: false, error: "denied" });
					socket.end();
				});
			}
		});
		socket.on("end", () => { if (!decoder.finish() && !settled) deny(); });
		socket.on("error", () => socket.destroy());
	}
}

export class NativeChildTransportClient implements NativeChildViewClient {
	private readonly endpoint: string;
	private readonly credential: string;
	private readonly expected: z.infer<typeof RedemptionIdentitySchema>;
	private readonly connect: (endpoint: string) => NativeChildTransportClientConnection;

	constructor(options: { endpoint: string; credential: string; expected: z.infer<typeof RedemptionIdentitySchema>; connect?: (endpoint: string) => NativeChildTransportClientConnection }) {
		this.endpoint = options.endpoint;
		this.credential = options.credential;
		this.expected = structuredClone(options.expected);
		this.connect = options.connect ?? createConnection;
	}

	attachRootView(onEvent: (event: unknown) => void, onDisconnect?: (reason: "closed" | "error") => void): Promise<() => void> {
		const id = randomUUID();
		const payload = JSON.stringify({ id, credential: this.credential, expected: this.expected, command: { type: "view-attach" } });
		return new Promise((resolve, reject) => {
			const socket = this.connect(this.endpoint);
			const decoder = new NativeChildFrameDecoder();
			let settled = false;
			let attached = false;
			let terminated = false;
			let intentionalDetach = false;
			let chunks: { id: string; next: number; parts: Buffer[] } | undefined;
			const fail = (error: Error, reason: "closed" | "error"): void => {
				if (terminated || intentionalDetach) return;
				terminated = true;
				clearTimeout(timer);
				socket.destroy();
				if (!settled) { settled = true; reject(error); }
				else if (attached) onDisconnect?.(reason);
			};
			const timer = setTimeout(() => fail(new Error("Native child view attach timed out"), "error"), 30_000);
			const acknowledge = (): void => {
				if (settled || terminated) return;
				attached = true;
				settled = true;
				clearTimeout(timer);
				resolve(() => {
					if (terminated || intentionalDetach) return;
					intentionalDetach = true;
					socket.end();
				});
			};
			socket.on("connect", () => socket.write(`${payload}\n`));
			socket.on("data", (chunk) => {
				if (terminated || intentionalDetach) return;
				for (const frame of decoder.feed(chunk)) {
					if (!("value" in frame) || typeof frame.value !== "object" || frame.value === null) { fail(new Error("Native child view denied"), "error"); return; }
					const chunk = chunkSchema.safeParse(frame.value);
					if (chunk.success) {
						const { id: chunkId, index, final, data } = chunk.data;
						if ((chunks && (chunks.id !== chunkId || chunks.next !== index)) || (!chunks && index !== 0)) { fail(new Error("Native child view denied"), "error"); return; }
						chunks ??= { id: chunkId, next: 0, parts: [] };
						chunks.parts.push(Buffer.from(data, "base64"));
						chunks.next++;
						if (final) {
							try {
								const reconstructed: unknown = JSON.parse(Buffer.concat(chunks.parts).toString("utf8"));
								const complete = eventSchema.parse(reconstructed);
								chunks = undefined;
								onEvent(complete.data);
							} catch { fail(new Error("Native child view denied"), "error"); return; }
						}
						continue;
					}
					const event = eventSchema.safeParse(frame.value);
					if (event.success && !chunks) {
						try { onEvent(event.data.data); }
						catch { fail(new Error("Native child view event rejected"), "error"); return; }
						continue;
					}
					const response = responseSchema.safeParse(frame.value);
					if (!response.success || response.data.id !== id) { fail(new Error("Native child view denied"), "error"); return; }
					if (response.data.ok && !attached) acknowledge();
					else fail(new Error("Native child view denied"), "error");
				}
			});
			socket.on("error", () => fail(new Error("Native child view unavailable"), "error"));
			socket.on("end", () => fail(new Error("Native child view closed"), chunks ? "error" : "closed"));
			socket.on("close", () => fail(new Error("Native child view unavailable"), chunks ? "error" : "closed"));
		});
	}

	request(command: NativeChildTransportRequest["command"], timeoutMs = 30_000): Promise<unknown> {
		const request = { credential: this.credential, expected: this.expected, command };
		const id = randomUUID();
		const payload = JSON.stringify({ ...request, id });
		if (Buffer.byteLength(payload, "utf8") > MAX_NATIVE_CHILD_FRAME_BYTES) return Promise.reject(new Error("Native child transport denied"));
		return new Promise((resolve, reject) => {
			const socket = this.connect(this.endpoint);
			const decoder = new NativeChildFrameDecoder();
			let settled = false;
			const timer = setTimeout(() => finish(new Error("Native child transport timed out")), timeoutMs);
			const finish = (error?: Error, value?: unknown): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.destroy();
				if (error) reject(error); else resolve(value);
			};
			socket.on("connect", () => socket.write(`${payload}\n`));
			socket.on("data", (chunk: Buffer) => {
				for (const frame of decoder.feed(chunk)) {
					if (!("value" in frame) || typeof frame.value !== "object" || frame.value === null) { finish(new Error("Native child transport denied")); return; }
					const response = responseSchema.safeParse(frame.value);
					if (!response.success || response.data.id !== id) { finish(new Error("Native child transport denied")); return; }
					if (response.data.ok) {
						if (command.type === "root-configure") {
							const configured = RootConfigureResponseSchema.safeParse(response.data.data);
							if (!configured.success) { finish(new Error("Native child transport denied")); return; }
							finish(undefined, configured.data);
						} else finish(undefined, response.data.data);
					} else finish(new Error("Native child transport denied"));
				}
			});
			socket.on("error", () => finish(new Error("Native child transport unavailable")));
			socket.on("end", () => { if (!settled) finish(new Error("Native child transport denied")); });
			socket.on("close", () => { if (!settled) finish(new Error("Native child transport unavailable")); });
		});
	}
}
