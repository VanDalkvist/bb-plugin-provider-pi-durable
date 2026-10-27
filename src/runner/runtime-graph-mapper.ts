import type { TaskGraph, TaskGraphNode, TaskRecord } from "@earendil-works/pi-durable";
import type { RuntimeTaskNode, TaskOutcomeName } from "../runtime-graph/types.ts";
import { MAX_LABEL_LENGTH } from "../runtime-graph/schema.ts";
import type { RuntimeGraphConversations } from "./runtime-graph-conversations.ts";
import type { TaskNames } from "./task-labels.ts";
import { taskLabel } from "./task-labels.ts";
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

export function extractTaskModelMeta(
	node: TaskGraphNode,
	current: unknown,
	rootConvId: number,
): ExtractedTaskMeta {
	if (node.kind !== "pi.generation") return {};
	const cp = (node as any).state?.checkpoint ?? (node as any).checkpoint;
	let provider: string | undefined;
	let modelId: string | undefined;
	let thinkingLevel: string | undefined;

	if (cp && typeof cp === "object" && cp.model && typeof cp.model === "object") {
		if (cp.model.provider && (cp.model.modelId || cp.model.id)) {
			provider = String(cp.model.provider);
			modelId = String(cp.model.modelId ?? cp.model.id);
		}
		if (cp.thinkingLevel !== undefined && cp.thinkingLevel !== null) {
			thinkingLevel = String(cp.thinkingLevel);
		}
	}

	if (!provider || !modelId) {
		const convId = Number(node.conversationId);
		if (convId === rootConvId) {
			const agentDoc = (current as any)?.conversation?.docs?.["pi.agent"];
			if (agentDoc?.model?.provider && (agentDoc.model.modelId || agentDoc.model.id)) {
				provider = String(agentDoc.model.provider);
				modelId = String(agentDoc.model.modelId ?? agentDoc.model.id);
			}
			if (agentDoc?.thinkingLevel !== undefined && agentDoc.thinkingLevel !== null) {
				thinkingLevel = String(agentDoc.thinkingLevel);
			}
		} else {
			const subagentsDoc = (current as any)?.conversation?.docs?.["bb.subagents"];
			const subRec = subagentsDoc?.agents
				? (Object.values(subagentsDoc.agents).find((a: any) => Number(a?.conversationId) === convId) as any)
				: undefined;
			if (subRec?.actualModel?.provider && (subRec.actualModel.modelId || subRec.actualModel.id)) {
				provider = String(subRec.actualModel.provider);
				modelId = String(subRec.actualModel.modelId ?? subRec.actualModel.id);
			}
			if (subRec?.thinkingLevel !== undefined && subRec.thinkingLevel !== null) {
				thinkingLevel = String(subRec.thinkingLevel);
			}
		}
	}

	if (!provider || !modelId) return {};
	const model = { provider, modelId };
	const modelLabel = thinkingLevel && thinkingLevel !== "off"
		? `assistant turn · ${modelId} (${thinkingLevel})`
		: `assistant turn · ${modelId}`;
	return { model, thinkingLevel, modelLabel };
}

export function recordSubagentOwnership(
	conversations: RuntimeGraphConversations,
	current: unknown,
	rootConvId: string | number,
): void {
	const doc = (current as any)?.conversation?.docs?.["bb.subagents"];
	if (!doc?.agents) return;
	for (const a of Object.values(doc.agents) as any[]) {
		if (a?.conversationId && a?.ownerTaskId) {
			conversations.recordLogicalOwner(Number(a.conversationId), Number(rootConvId), Number(a.ownerTaskId));
		}
	}
}

export function buildMappedNode(
	node: TaskGraphNode,
	current: unknown,
	rootConvId: number,
	names: TaskNames,
	nativeStartedAt: Map<number, number>,
	clock: () => number,
): RuntimeTaskNode {
	const id = Number(node.id);
	const convId = Number(node.conversationId);
	const meta = extractTaskModelMeta(node, current, rootConvId);
	let label = taskLabel(node, names, meta.modelLabel);
	if (label.length > MAX_LABEL_LENGTH) label = label.slice(0, MAX_LABEL_LENGTH);

	const callDetails = names.getDetails(String(id));
	const startedAt = (node as any).startedAt !== undefined && (node as any).startedAt !== null
		? Number((node as any).startedAt)
		: nativeStartedAt.get(id);
	const durationMs = startedAt !== undefined ? Math.max(0, clock() - startedAt) : undefined;

	return {
		id, kind: node.kind, conversationId: convId,
		owner: node.owner !== undefined ? Number(node.owner) : undefined,
		background: Boolean(node.background), abortRequested: Boolean(node.abortRequested),
		state: mapTaskGraphNodeState(node.state), blocked: node.blocked, label,
		startedAt, durationMs,
		toolName: callDetails?.toolName,
		targetHint: callDetails?.targetHint,
		model: meta.model,
		thinkingLevel: meta.thinkingLevel,
	};
}

export function recordTerminalWithDetails(
	receipts: RuntimeGraphReceiptsCollector,
	task: TaskRecord<unknown, unknown, unknown>,
	names: TaskNames,
	nativeStartedAt: Map<number, number>,
): void {
	const id = Number(task.id);
	const details = names.getDetails(String(id));
	receipts.recordTerminal(task, {
		preview: details?.preview ?? names.get(String(id)),
		toolName: details?.toolName,
		targetHint: details?.targetHint,
		startedAt: nativeStartedAt.get(id),
	});
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
