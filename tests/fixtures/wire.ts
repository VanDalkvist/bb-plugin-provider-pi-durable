import { z } from "zod";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { runnerEventSchema, type RunnerEvent } from "../../src/contracts/runner-event.ts";
import { assistantMessageSchema, type BBAssistantMessage } from "../../src/contracts/wire-message.ts";

export function publicDeltaFixture(value: unknown) { return threadDeltaSchema.parse(value); }
export function publicDeltasFixture(value: unknown) { return z.array(threadDeltaSchema).parse(value); }

type Kind = RunnerEvent["type"];
type Event<K extends Kind> = Extract<RunnerEvent, { type: K }>;
const base = {
 agent_start: { type: "agent_start" }, turn_start: { type: "turn_start" },
 turn_end: { type: "turn_end" }, agent_end: { type: "agent_end", messages: [] },
 context_window: { type: "context_window", usedTokens: null, contextWindow: 8192 },
 message_end: { type: "message_end", message: { role: "assistant", content: [] } },
 message_update: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "" } },
 tool_execution_start: { type: "tool_execution_start", toolCallId: "fixture-call", toolName: "fixture", args: {} },
 tool_execution_update: { type: "tool_execution_update", toolCallId: "fixture-call", toolName: "fixture", partialResult: "" },
 tool_execution_end: { type: "tool_execution_end", toolCallId: "fixture-call", toolName: "fixture", result: "", isError: false },
 compaction_start: { type: "compaction_start", reason: "manual" },
 compaction_end: { type: "compaction_end", reason: "manual", aborted: false },
 auto_retry_start: { type: "auto_retry_start", attempt: 1 },
 auto_retry_end: { type: "auto_retry_end", attempt: 1, success: true },
 tasks_snapshot: { type: "tasks_snapshot", steps: [] },
 runtime_graph_snapshot: {
  type: "runtime_graph_snapshot",
  snapshot: {
   version: 1 as const,
   scope: { sessionId: "sess_fixture", rootConversationId: "1", buildId: "b1" },
   observation: { epoch: "e1", revision: 1, observedAt: 1000, completeness: "complete" as const },
   nodes: {},
   conversations: { "1": { id: 1 } },
   receipts: [],
   stats: { liveCount: 0, terminalCount: 0, totalCount: 0 },
  },
 },
} satisfies { [K in Kind]: Event<K> };

/** A complete baseline, typed overrides and the actual wire validator, never a partial-event assertion. */
export function wireFixture<K extends Kind>(kind: K, overrides: Partial<Event<K>> = {}): Event<K> {
 const event = runnerEventSchema.parse({ ...base[kind], ...overrides, type: kind });
 if (event.type !== kind) throw new Error("FIXTURE_EVENT_KIND_MISMATCH");
 // Zod validated the entire packet; this assertion only preserves the generic discriminator correlation.
 return event as Event<K>;
}
export function assistantFixture(overrides: Partial<BBAssistantMessage> = {}): BBAssistantMessage {
 return assistantMessageSchema.parse({ role: "assistant", content: [], ...overrides });
}
