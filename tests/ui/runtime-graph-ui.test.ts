import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "../setup-dom.ts";
import type { RuntimeGraphSnapshot } from "../../src/runtime-graph/types.ts";
import { useRuntimeGraphVisible } from "../../src/ui/runtime-graph/use-runtime-graph-visible.ts";

setupDom();
const { installTestPluginRuntime } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { renderHook, act } = await import("@testing-library/react");
const { useRuntimeGraphState } = await import("../../src/ui/runtime-graph/use-runtime-graph-state.ts");

function createMockSnapshot(overrides?: Partial<RuntimeGraphSnapshot>): RuntimeGraphSnapshot {
	return {
		version: 1,
		scope: {
			sessionId: "session-1",
			rootConversationId: "1",
			buildId: "build-1",
		},
		observation: {
			epoch: "epoch-1",
			revision: 1,
			observedAt: 1000,
			completeness: "complete",
		},
		nodes: {
			"1": {
				id: 1,
				kind: "pi.generation",
				conversationId: 1,
				background: false,
				abortRequested: false,
				state: { status: "running", phase: "generating" },
				label: "Root Gen",
			},
		},
		conversations: { "1": { id: 1 } },
		receipts: [],
		stats: { liveCount: 1, terminalCount: 0, totalCount: 1 },
		...overrides,
	};
}

test("useRuntimeGraphState: manages snapshot, tree items, and status", async () => {
	let realtimeCallback: ((event: unknown) => void) | undefined;
	let currentSnapshot = createMockSnapshot();

	const mockSdk: any = {
		threads: {
			events: {
				list: async () => [
					{
						kind: "provider-pi-durable/runtime-graph",
						payload: currentSnapshot,
						seq: 1,
					},
				],
			},
		},
		subscribe: (args: any) => {
			if (args.event === "thread:changed") {
				realtimeCallback = args.callback;
			}
			return () => {
				realtimeCallback = undefined;
			};
		},
	};

	const { result, unmount } = renderHook(() =>
		useRuntimeGraphState(mockSdk, "thread-1"),
	);

	// Initial render is loading or resolving
	assert.equal(result.current.threadId, "thread-1");

	// Wait for fetch
	await act(async () => {
		await new Promise((r) => setTimeout(r, 60));
	});

	assert.equal(result.current.status, "ok");
	assert.ok(result.current.snapshot);
	assert.equal(result.current.tree.length, 1);
	assert.equal(result.current.tree[0].id, 1);

	// Select task
	act(() => {
		result.current.selectTask(1);
	});
	assert.equal(result.current.selectedTaskId, 1);
	assert.equal(result.current.selectedItem?.id, 1);

	// Revision update within same epoch preserves selection
	currentSnapshot = createMockSnapshot({
		observation: {
			epoch: "epoch-1",
			revision: 2,
			observedAt: 1100,
			completeness: "complete",
		},
	});

	await act(async () => {
		realtimeCallback?.({ threadId: "thread-1" });
		await new Promise((r) => setTimeout(r, 150));
	});

	assert.equal(result.current.selectedTaskId, 1, "Selection must be retained across same epoch revision update");

	// Epoch reset (e.g. restart or new session) resets selection
	currentSnapshot = createMockSnapshot({
		observation: {
			epoch: "epoch-2",
			revision: 1,
			observedAt: 2000,
			completeness: "complete",
		},
	});

	await act(async () => {
		realtimeCallback?.({ threadId: "thread-1" });
		await new Promise((r) => setTimeout(r, 150));
	});

	assert.equal(result.current.selectedTaskId, null, "Selection must be reset on epoch change");

	unmount();
});

test("useRuntimeGraphVisible: checks thread providerId from sidebar threads", () => {
	// If sidebar threads are ready and thread is not found, fails closed (returns false)
	const visibleDefault = useRuntimeGraphVisible({
		threadId: "test-thread",
		projectId: "proj-1",
		environment: null,
	}, {
		sidebarThreads: {
			status: "ready",
			threads: [],
		} as any,
	});
	assert.equal(visibleDefault, false);

	// If thread is found and provider is foreign, returns false
	const visibleForeign = useRuntimeGraphVisible({
		threadId: "thread-foreign",
		projectId: "proj-1",
		environment: null,
	}, {
		sidebarThreads: {
			status: "ready",
			threads: [
				{ id: "thread-foreign", providerId: "anthropic" } as any,
			],
		} as any,
	});
	assert.equal(visibleForeign, false);

	// If thread is found and provider is pi-durable, returns true
	const visiblePiDurable = useRuntimeGraphVisible({
		threadId: "thread-pi",
		projectId: "proj-1",
		environment: null,
	}, {
		sidebarThreads: {
			status: "ready",
			threads: [
				{ id: "thread-pi", providerId: "pi-durable" } as any,
			],
		} as any,
	});
	assert.equal(visiblePiDurable, true);
});
