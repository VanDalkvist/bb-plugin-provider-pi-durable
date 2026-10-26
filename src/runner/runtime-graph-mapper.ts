import type { TaskGraph, TaskGraphNode } from "@earendil-works/pi-durable";
import type { RuntimeTaskNode, TaskOutcomeName } from "../runtime-graph/types.ts";

export function extractTaskGraph(current: unknown): TaskGraph {
	if (!current || typeof current !== "object") return { tasks: {} };
	const obj = current as Record<string, unknown>;
	if ("tasks" in obj && obj.tasks && typeof obj.tasks === "object") {
		const inner = obj.tasks as Record<string, unknown>;
		if ("tasks" in inner && inner.tasks && typeof inner.tasks === "object") {
			return inner as TaskGraph;
		}
		return current as TaskGraph;
	}
	return { tasks: {} };
}

export function mapTaskGraphNodeState(state: TaskGraphNode["state"]): RuntimeTaskNode["state"] {
	switch (state.status) {
		case "pending":
		case "running":
			return { status: state.status, phase: state.phase };
		case "waiting":
			return {
				status: "waiting",
				phase: state.phase,
				on: state.on ? state.on.map(Number) : [],
				policy: state.policy,
			};
		case "sleeping":
			return { status: "sleeping", phase: state.phase, until: state.until };
		case "completing":
			return { status: "completing", outcome: state.outcome as TaskOutcomeName };
	}
}
