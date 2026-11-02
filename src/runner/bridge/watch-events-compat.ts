import { NestedCallDoc } from "@earendil-works/pi-durable";
import type { AgentEvent, AgentEventStream, SnapshotEvent } from "./durable-contracts.ts";

/** Compatibility shim for watchEvents over native conversation.watch in Pi 1.5.0 */
export async function watchEvents(
	harness: any,
	conversationId: any,
	context: any,
): Promise<AgentEventStream> {
	const conversation = await harness.conversation(conversationId, context);
	if (!conversation) throw new Error(`Conversation not found: ${conversationId}`);
	const watch = await conversation.watch(context);
	const initial = watch.value;
	const snapshot: SnapshotEvent = {
		type: "snapshot",
		entries: initial?.entries ?? [],
		...(initial?.docs?.["pi.live"]?.run ? { run: { inputs: initial.docs["pi.live"].run.inputs } } : {}),
		tools: initial?.docs?.["pi.live"]?.tools ?? [],
		nestedTools: initial?.docs?.["pi.live"]?.nestedTools ?? [],
		compactions: initial?.docs?.["pi.live"]?.compactions ?? [],
		inbox: [],
		agent: initial?.docs?.["pi.agent"] ?? {},
		usage: initial?.docs?.["pi.usage"] ?? {},
	};

	return {
		snapshot,
		start(listener) {
			let seenEntriesCount = initial?.entries?.length ?? 0;
			const emittedToolEnds = new Set<string>();
			const seenNestedTools = new Map<string, any>();

			watch.start(async (call: any, ctx: any) => {
				const val = call?.value ?? call;
				if (!val) return;
				const events: AgentEvent[] = [];

				// Track nested tools from pi.live
				const nested = val.docs?.["pi.live"]?.nestedTools ?? [];
				for (const n of nested) {
					if (n.callId && !seenNestedTools.has(n.callId)) {
						seenNestedTools.set(n.callId, n);
					}
					if (n.callId && n.status === "done" && !emittedToolEnds.has(n.callId)) {
						emittedToolEnds.add(n.callId);
						const toolName = n.name ?? n.toolName ?? "tool";
						let nestedResult: any;
						if (n.parentTaskId && typeof harness.snapshot === "function") {
							const key = n.callId.split("/").pop();
							try {
								const stored = await harness.snapshot(NestedCallDoc, n.parentTaskId, key, context);
								nestedResult = stored?.result;
							} catch {}
						}
						events.push({
							type: "tool_execution_end",
							toolCallId: n.callId,
							toolName,
							taskId: n.taskId,
							parentToolCallId: n.parentCallId,
							parentTaskId: n.parentTaskId,
							result: nestedResult ?? {
								isError: Boolean(n.summary?.isError ?? n.summary?.error ?? n.isError),
								output: n.output,
								details: n.details,
							},
						});
					}
				}

				// Check any nested tools that finished when live.nestedTools cleared
				if (!val.docs?.["pi.live"]?.nestedTools && seenNestedTools.size > 0) {
					for (const [callId, n] of seenNestedTools) {
						if (!emittedToolEnds.has(callId)) {
							emittedToolEnds.add(callId);
							const toolName = n.name ?? n.toolName ?? "tool";
							events.push({
								type: "tool_execution_end",
								toolCallId: callId,
								toolName,
								taskId: n.taskId,
								parentToolCallId: n.parentCallId,
								parentTaskId: n.parentTaskId,
								result: n.result ?? {
									isError: Boolean(n.summary?.isError ?? n.summary?.error ?? n.isError),
									output: n.output,
									details: n.details,
								},
							});
						}
					}
				}

				if (val.entries?.length && val.entries.length > seenEntriesCount) {
					for (let i = seenEntriesCount; i < val.entries.length; i++) {
						const entry = val.entries[i];
						const modelMsg = entry?.model?.[0];
						if (modelMsg?.role === "toolResult") {
							let toolName = modelMsg.toolName ?? "tool";
							if (!modelMsg.toolName) {
								for (let j = i - 1; j >= 0; j--) {
									const prevMsg = val.entries[j]?.model?.[0];
									if (prevMsg?.role === "assistant" && Array.isArray(prevMsg.content)) {
										const call = prevMsg.content.find((c: any) => c.type === "toolCall" && c.id === modelMsg.toolCallId);
										if (call?.name) {
											toolName = call.name;
											break;
										}
									}
								}
							}
							const callId = modelMsg.toolCallId ?? String(entry.id);
							if (!emittedToolEnds.has(callId)) {
								emittedToolEnds.add(callId);
								events.push({
									type: "tool_execution_end",
									toolCallId: callId,
									toolName,
									entry,
								});
							}
						}
						events.push({ type: "entry_appended", entry });
					}
					seenEntriesCount = val.entries.length;
				}
				if (events.length > 0) {
					await listener(events, ctx);
				}
			});
		},
		async stop() {
			return watch.stop(context);
		},
	};
}
