import type { ThreadDelta } from "./types.ts";
import type { ReasoningTranslationState } from "./message-state.ts";

export const REASONING_PRESENTATION = {
 label: { pending: "Thinking", completed: "Thought" },
 icon: { glyph: "Brain" },
};

function ensureOpen(channel: string, parentRef: string | undefined, hide: boolean, state: ReasoningTranslationState, deltas: ThreadDelta[]): void {
 state.openThinkingChannels ??= new Set();
 if (state.openThinkingChannels.has(channel)) return;
 state.openThinkingChannels.add(channel);
 deltas.push({
  kind: "item.open", key: { channel, ...(parentRef ? { parentRef } : {}) },
  item: { type: "reasoning", summary: [], content: [], ...(parentRef ? { parentToolCallId: parentRef } : {}) },
  presentation: { ...REASONING_PRESENTATION, ...(hide ? { suppress: true } : {}) },
 });
}

export function translateReasoningUpdate(asst: Record<string, unknown>, state: ReasoningTranslationState, hide: boolean, parentRef?: string): ThreadDelta[] {
 const deltas: ThreadDelta[] = [];
 const index = typeof asst.contentIndex === "number" ? asst.contentIndex : state.currentThinkingIndex;
 const channel = parentRef ? `${parentRef}:thinking-${index}` : `thinking-${index}`;
 if (asst.type === "thinking_start") {
  ensureOpen(channel, parentRef, hide, state, deltas);
 } else if (asst.type === "thinking_delta" && typeof asst.delta === "string") {
  ensureOpen(channel, parentRef, hide, state, deltas);
  deltas.push({ kind: "item.textDelta", key: { channel, ...(parentRef ? { parentRef } : {}) }, channel: "reasoningText", text: asst.delta });
 } else if (asst.type === "thinking_end") {
  deltas.push({ kind: "item.textClose", key: { channel, ...(parentRef ? { parentRef } : {}) }, channel: "reasoningText", text: typeof asst.content === "string" ? asst.content : "" });
  state.openThinkingChannels?.delete(channel);
  state.currentThinkingIndex++;
 } else if (asst.type === "text_delta" && typeof asst.delta === "string") {
  for (const open of state.openThinkingChannels ?? []) {
   deltas.push({ kind: "item.textClose", key: { channel: open, ...(parentRef ? { parentRef } : {}) }, channel: "reasoningText", text: "" });
  }
  state.openThinkingChannels?.clear();
 }
 return deltas;
}
