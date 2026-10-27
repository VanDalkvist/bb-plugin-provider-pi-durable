import {
	type AgentEvent,
	type AgentEventStream,
	type ConversationId,
	type Harness,
	ROOT_CONVERSATION_ID,
	watchEvents as defaultWatchEvents,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { BBEventAdapter } from "./bridge/bb-event-adapter.ts";
import type { BBChildEventAdapter } from "./bridge/bb-child-event-adapter.ts";
import type { DurableView, SubagentWatcherController } from "./runtime-types.ts";
import { extractCanonicalToolDetails } from "./bridge/native-tool-result.ts";
import { BindingIndexDoc } from "./binding-docs.ts";
import { SubagentsDoc } from "./subagent-docs.ts";

export type { SubagentWatcherController };

export interface SubagentWatcherOptions {
	watchEventsFn?: (harness: Harness, conversationId: ConversationId, ctx: typeof BACKGROUND_CONTEXT) => Promise<AgentEventStream>;
}

function extractChildConversationId(event: AgentEvent): ConversationId | undefined {
	if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
		const details = extractCanonicalToolDetails(event) as { conversationId?: ConversationId } | undefined;
		return details?.conversationId;
	}
	return undefined;
}

/**
 * Multiplexes native pi-durable conversation event streams into the BB event adapter.
 * Automatically discovers subagent conversations via tool execution details and
 * streams their inner reasoning and tool executions in-place under parent delegation cards.
 */
export async function startSubagentWatcher(
	harness: Harness,
	adapter: BBEventAdapter,
	getCurrentView: () => DurableView,
	options?: SubagentWatcherOptions,
): Promise<SubagentWatcherController> {
	const watch = options?.watchEventsFn ?? defaultWatchEvents;
	const attached = new Set<ConversationId>();
	const activeStreams = new Map<ConversationId, AgentEventStream>();

	const attach = async (conversationId: ConversationId, parentCallId?: string): Promise<void> => {
		if (attached.has(conversationId)) return;
		attached.add(conversationId);

		const isChild = parentCallId !== undefined;
		const childAdapter: BBChildEventAdapter | undefined = isChild
			? adapter.createChildAdapter(parentCallId, conversationId)
			: undefined;

		try {
			const stream = await watch(harness, conversationId, BACKGROUND_CONTEXT);
			activeStreams.set(conversationId, stream);

			stream.start(async (batch: readonly AgentEvent[]) => {
				try {
					const view = getCurrentView();
					if (childAdapter) {
						childAdapter.handleBatch(batch, view);
					} else {
						adapter.handleBatch(batch, view);
					}
					for (const event of batch) {
						const childId = extractChildConversationId(event);
						if (childId !== undefined && !attached.has(childId)) {
							const callId = "toolCallId" in event
								? (isChild ? `${parentCallId}:${String(event.toolCallId)}` : String(event.toolCallId))
								: (parentCallId ?? "subagent");
							void attach(childId, callId);
						}
					}
				} catch (err) {
					console.error(`[SubagentWatcher] Batch handling error for conversation ${conversationId}:`, err);
				}
			});
		} catch (err) {
			console.error(`[SubagentWatcher] Failed to attach stream for conversation ${conversationId}:`, err);
		}
	};

	await attach(ROOT_CONVERSATION_ID);

	try {
		const index = await harness.snapshot(BindingIndexDoc, BACKGROUND_CONTEXT);
		if (index?.byThreadId) {
			for (const convId of Object.values(index.byThreadId)) {
				if (convId && convId !== ROOT_CONVERSATION_ID) {
					await attach(convId as ConversationId, "subagent");
				}
			}
		}
		const subagents = await harness.snapshot(SubagentsDoc, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
		if (subagents?.agents) {
			for (const agent of Object.values(subagents.agents)) {
				if (agent?.conversationId && agent.conversationId !== ROOT_CONVERSATION_ID) {
					await attach(agent.conversationId, String(agent.ownerTaskId ?? "subagent"));
				}
			}
		}
	} catch (err) {
		console.warn(`[SubagentWatcher] Bootstrap child discovery warning: ${err instanceof Error ? err.message : String(err)}`);
	}

	return {
		ensureAttached: async (conversationId: ConversationId, parentCallId?: string) => {
			await attach(conversationId, parentCallId ?? "subagent");
		},
		close: () => {
			for (const stream of activeStreams.values()) {
				try {
					stream.stop();
				} catch (err) {
					console.warn(`[SubagentWatcher] Stream stop warning: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			activeStreams.clear();
			attached.clear();
		},
	};
}
