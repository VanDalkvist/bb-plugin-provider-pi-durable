import { z } from "zod";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EntryId, EntryRecord, JsonObject, TaskGraph, TaskGraphNode, TaskId } from "@earendil-works/pi-durable";
import type { DurableView, DurableViewSource } from "../../src/runner/runtime-types.ts";
import { parseConversationId } from "../../src/runner/conversation-id.ts";

function positiveId(value: number): number {
 if (!Number.isSafeInteger(value) || value <= 0) throw new Error("INVALID_FIXTURE_ID");
 return value;
}
// Public native IDs are erased nominal positive integers, not fabricated strings or unchecked SDK objects.
export function taskId(value: number): TaskId { return positiveId(value) as TaskId; }
export function entryId(value: number): EntryId { return positiveId(value) as EntryId; }
export function jsonFixture(value: unknown): JsonObject { return z.record(z.string(), z.json()).parse(value); }
type ViewOverrides = Omit<Partial<DurableView>, "conversation"> & { conversation?: Partial<DurableView["conversation"]> };
export function viewFixture(overrides: ViewOverrides = {}): DurableView {
 return {
  session: { id: "fixture", directory: "/fixture", cwd: "/fixture" },
  conversations: [], models: [], notices: [], ...overrides,
  conversation: { conversation: { id: parseConversationId(1) }, entries: [], docs: {}, ...overrides.conversation },
 };
}
export function viewSourceFixture(source: DurableViewSource): DurableViewSource { return source; }
export function taskViewSourceFixture(source: { current(): Pick<DurableView, "tasks">; subscribe: DurableViewSource["subscribe"] }): DurableViewSource {
 return { current: () => viewFixture(source.current()), subscribe: (listener) => source.subscribe(listener) };
}
type EntryInput = Omit<Partial<EntryRecord>, "id" | "conversationId"> & { id?: number; conversationId?: number };
export function entryFixture(overrides: EntryInput = {}): EntryRecord {
 return { kind: "fixture", ...overrides, id: entryId(overrides.id ?? 1), conversationId: parseConversationId(overrides.conversationId ?? 1) };
}
export function nativeAssistantFixture(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
 return { ...fauxAssistantMessage(""), ...overrides };
}
type NodeInput = Omit<TaskGraphNode, "id" | "owner" | "conversationId" | "conversations"> & {
 id: number; conversationId: number; owner?: number; conversations: readonly number[];
};
export function taskNodeFixture(input: NodeInput): TaskGraphNode {
 const { owner, ...rest } = input;
 return { ...rest, id: taskId(input.id), conversationId: parseConversationId(input.conversationId),
  conversations: input.conversations.map(parseConversationId), ...(owner === undefined ? {} : { owner: taskId(owner) }) };
}
export function graphFixture(tasks: TaskGraph["tasks"]): TaskGraph {
 for (const [key, node] of Object.entries(tasks)) if (key !== String(node.id)) throw new Error("INVALID_FIXTURE_GRAPH_KEY");
 return { tasks };
}
