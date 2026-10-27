import test from "node:test";
import assert from "node:assert/strict";
import { startSubagentWatcher, type SubagentWatcherController } from "../src/runner/subagent-watcher.ts";
import { BBEventAdapter } from "../src/runner/bridge/bb-event-adapter.ts";
import type { AgentEvent, ConversationId, Harness } from "@earendil-works/pi-durable";
import { BindingIndexDoc } from "../src/runner/binding-docs.ts";
import { SubagentsDoc } from "../src/runner/subagent-docs.ts";

function createMockHarness(existingBindings: Record<string, ConversationId> = {}) {
	const streamListeners = new Map<number, (events: readonly AgentEvent[], ctx: any) => Promise<void>>();
	const stoppedStreams = new Set<number>();

	const harness: any = {
		snapshot: async (docDef: any) => {
			const kind = docDef?.definition?.kind ?? docDef?.kind;
			if (kind === "bb.native-child-binding-index") {
				return { byThreadId: existingBindings, byIdentity: {} };
			}
			if (kind === "bb.subagents") {
				return { agents: {} };
			}
			return undefined;
		},
		simulateBatch: async (convId: number, batch: AgentEvent[]) => {
			const listener = streamListeners.get(convId);
			if (listener) {
				await listener(batch, {});
			}
		},
		getAttachedConversations: () => Array.from(streamListeners.keys()),
	};

	const watchEvents = async (_harness: Harness, conversationId: ConversationId) => {
		const idNum = Number(conversationId);
		return {
			snapshot: { type: "snapshot", entries: [], tools: [], nestedTools: [], compactions: [], inbox: [], agent: {} as any, usage: {} as any },
			start: (listener: (events: readonly AgentEvent[], ctx: any) => Promise<void>) => {
				streamListeners.set(idNum, listener);
			},
			stop: async () => {
				stoppedStreams.add(idNum);
				streamListeners.delete(idNum);
				return { at: 0 };
			},
		};
	};

	return { harness, watchEvents, streamListeners, stoppedStreams };
}

test("startSubagentWatcher: bootstraps existing subagent conversations on initialization", async () => {
	const { harness, watchEvents } = createMockHarness({ thr_child_1: 21848 as ConversationId });
	const emitted: any[] = [];
	const adapter = new BBEventAdapter((evt) => emitted.push(evt));

	const watcher = await startSubagentWatcher(
		harness,
		adapter,
		() => ({} as any),
		{ watchEventsFn: watchEvents },
	);

	try {
		const attached = harness.getAttachedConversations();
		assert.ok(attached.includes(1), "Root conversation 1 must be attached");
		assert.ok(attached.includes(21848), "Pre-existing child conversation 21848 must be attached on bootstrap");
	} finally {
		watcher.close();
	}
});

test("startSubagentWatcher: ensureAttached attaches on resume without duplicate streams", async () => {
	const { harness, watchEvents } = createMockHarness();
	const emitted: any[] = [];
	const adapter = new BBEventAdapter((evt) => emitted.push(evt));

	const watcher = await startSubagentWatcher(
		harness,
		adapter,
		() => ({} as any),
		{ watchEventsFn: watchEvents },
	);

	try {
		assert.equal(harness.getAttachedConversations().includes(26015), false);
		await watcher.ensureAttached(26015 as ConversationId);
		assert.equal(harness.getAttachedConversations().includes(26015), true);

		// Duplicate ensureAttached should be a no-op
		await watcher.ensureAttached(26015 as ConversationId);
		assert.equal(harness.getAttachedConversations().filter((id: number) => id === 26015).length, 1);
	} finally {
		watcher.close();
	}
});
