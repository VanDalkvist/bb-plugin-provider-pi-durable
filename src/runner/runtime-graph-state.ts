import type { TaskGraph, TaskGraphNode, TaskRecord } from "@earendil-works/pi-durable";
import type { RuntimeTaskNode, TaskOutcomeName } from "../runtime-graph/types.ts";
import type { RuntimeGraphReceiptsCollector } from "./runtime-graph-receipts.ts";

export interface ViewSource {
	current(): { tasks?: unknown } | undefined;
	subscribe(listener: () => void): () => void;
}

export interface HarnessGraphSource {
	getTask?(id: unknown, context?: unknown): Promise<TaskRecord<unknown, unknown, unknown> | undefined>;
	subscribeCommits?(listener: (publication: { readonly changes: readonly unknown[] }, context?: unknown) => void): () => void;
}

export interface RuntimeGraphSourceOptions {
	readonly debounceMs?: number;
	readonly maxDebounceMs?: number;
	readonly clock?: () => number;
	readonly receipts?: RuntimeGraphReceiptsCollector;
	readonly harness?: HarnessGraphSource;
}

export interface ExtractedTaskMeta {
	readonly model?: { readonly provider: string; readonly modelId: string };
	readonly thinkingLevel?: string;
	readonly modelLabel?: string;
}

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
		case "completing": {
			const outcome =
				typeof state.outcome === "object" && state.outcome !== null && "status" in (state.outcome as Record<string, unknown>)
					? (state.outcome as { status: unknown }).status
					: state.outcome;
			return { status: "completing", outcome: (outcome as TaskOutcomeName) ?? "completed" };
		}
	}
}
