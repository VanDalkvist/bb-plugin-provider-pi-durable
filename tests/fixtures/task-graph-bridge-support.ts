import type { TaskGraph, TaskGraphNode, TaskGraphState } from "@earendil-works/pi-durable";
import type { DurableView } from "../../src/runner/runtime-types.ts";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { jsonFixture, taskNodeFixture, graphFixture, viewFixture } from "./durable.ts";

function node(id: number, kind: string, state: TaskGraphState, owner?: number): TaskGraphNode {
    return taskNodeFixture({
        id,
        kind,
        conversationId: 1,
        ...(owner === undefined ? {} : { owner }),
        background: false,
        abortRequested: false,
        state,
        conversations: [],
    });
}

function graph(tasks: Record<string, TaskGraphNode>): TaskGraph {
    return graphFixture(tasks);
}

function liveView(live: unknown, entries: EntryRecord[] = []): DurableView {
    return viewFixture({ conversation: { docs: { "pi.live": jsonFixture(live) }, entries } });
}

function runningCall(callId: string, name: string, taskId: number, args: Record<string, unknown>): DurableView {
	return liveView({
		tools: [{ callId, name, status: "running", taskId }],
		generation: { message: { content: [{ type: "toolCall", id: callId, arguments: args }] } },
	});
}
export { node, graph, liveView, runningCall };
