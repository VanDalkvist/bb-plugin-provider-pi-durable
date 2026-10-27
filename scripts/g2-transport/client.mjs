/**
 * Public BB HTTP & Realtime WebSocket client adapter.
 * Conforms to RuntimeGraphRealtimeClient (threads.events.list + realtime.subscribe).
 */

export function createLiveTransportClient(options = {}) {
	const serverUrl = (options.serverUrl || process.env.BB_SERVER_URL || "http://127.0.0.1:38886").replace(/\/+$/, "");
	const wsUrl = options.wsUrl || serverUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:") + "/ws";
	const fetchFn = options.fetchFn || fetch;
	const WebSocketClass = options.WebSocketClass || globalThis.WebSocket;

	let socket = null;
	let isClosed = false;
	const activeListeners = new Set();

	function ensureSocket() {
		if (isClosed || socket !== null) return socket;
		if (typeof WebSocketClass !== "function") {
			throw new Error("No WebSocket implementation available for BB realtime subscription.");
		}

		socket = new WebSocketClass(wsUrl);

		socket.onopen = () => {
			for (const listener of activeListeners) {
				if (socket?.readyState === 1) {
					socket.send(JSON.stringify({
						type: "subscribe",
						target: { kind: "thread-detail", threadId: listener.threadId },
					}));
				}
			}
		};

		socket.onmessage = (event) => {
			if (typeof event.data !== "string") return;
			try {
				const msg = JSON.parse(event.data);
				if (msg?.type === "changed" && msg.entity === "thread" && msg.id) {
					for (const listener of activeListeners) {
						if (listener.threadId === msg.id && listener.event === "thread:changed") {
							try {
								listener.callback(msg);
							} catch (cbErr) {
								console.error("[g2-client] listener callback error:", cbErr);
							}
						}
					}
				}
			} catch {
				// Ignore non-json or malformed frames
			}
		};

		socket.onerror = (err) => {
			console.error("[g2-client] WebSocket error:", err);
		};

		socket.onclose = () => {
			socket = null;
		};

		return socket;
	}

	const subscribe = (args) => {
		const { event, threadId, callback } = args;
		const listener = { event, threadId, callback };
		activeListeners.add(listener);

		const ws = ensureSocket();
		if (ws?.readyState === 1) {
			ws.send(JSON.stringify({
				type: "subscribe",
				target: { kind: "thread-detail", threadId },
			}));
		}

		return () => {
			activeListeners.delete(listener);
			if (socket?.readyState === 1) {
				try {
					socket.send(JSON.stringify({
						type: "unsubscribe",
						target: { kind: "thread-detail", threadId },
					}));
				} catch {
					// Socket may be closing
				}
			}
			if (activeListeners.size === 0 && socket) {
				socket.close();
				socket = null;
			}
		};
	};

	const client = {
		threads: {
			events: {
				async list(args) {
					const { threadId, types, order, limit, beforeSeq, signal } = args;
					const params = new URLSearchParams();
					if (types && types.length > 0) {
						params.set("types", types.join(","));
					}
					if (order) params.set("order", order);
					if (limit) params.set("limit", String(limit));
					if (beforeSeq) params.set("beforeSeq", String(beforeSeq));

					const url = `${serverUrl}/api/v1/threads/${encodeURIComponent(threadId)}/events?${params.toString()}`;
					const res = await fetchFn(url, { signal });
					if (!res.ok) {
						throw new Error(`Failed to list thread events: HTTP ${res.status}`);
					}
					return await res.json();
				},
			},
		},
		subscribe,
		realtime: {
			subscribe,
		},
		close() {
			isClosed = true;
			activeListeners.clear();
			if (socket) {
				try {
					socket.close();
				} catch {
					// Socket closing error ignore
				}
				socket = null;
			}
		},
	};

	return client;
}
