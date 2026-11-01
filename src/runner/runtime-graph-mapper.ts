import type { TaskGraphNode, TaskRecord } from "@earendil-works/pi-durable";
import type { RuntimeTaskNode } from "../runtime-graph/types.ts";
import { MAX_LABEL_LENGTH } from "../runtime-graph/schema.ts";
import type { RuntimeGraphConversations } from "./runtime-graph-conversations.ts";
import type { TaskNames } from "./task-labels.ts";
import { taskLabel } from "./task-labels.ts";
import type { RuntimeGraphReceiptsCollector } from "./runtime-graph-receipts.ts";
import { extractLiveTokens, extractTerminalTokens } from "./task-tokens.ts";
import {
	mapTaskGraphNodeState,
	type ExtractedTaskMeta,
	type ViewSource,
	type HarnessGraphSource,
	type RuntimeGraphSourceOptions,
} from "./runtime-graph-state.ts";

export { extractTaskGraph, mapTaskGraphNodeState } from "./runtime-graph-state.ts";
export type { ViewSource, HarnessGraphSource, RuntimeGraphSourceOptions, ExtractedTaskMeta };

export function extractTaskModelMeta(node: TaskGraphNode, current: unknown, rootConvId: number): ExtractedTaskMeta {
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
		if (cp.thinkingLevel !== undefined && cp.thinkingLevel !== null) thinkingLevel = String(cp.thinkingLevel);
	}

	if (!provider || !modelId) {
		const convId = Number(node.conversationId);
		if (convId === rootConvId) {
			const doc = (current as any)?.conversation?.docs?.["pi.agent"];
			if (doc?.model?.provider) { provider = String(doc.model.provider); modelId = String(doc.model.modelId ?? doc.model.id); }
			if (doc?.thinkingLevel !== undefined && doc?.thinkingLevel !== null) thinkingLevel = String(doc.thinkingLevel);
		} else {
			const doc = (current as any)?.conversation?.docs?.["durable.subagents"];
			const sub = doc?.agents ? (Object.values(doc.agents).find((a: any) => Number(a?.conversationId) === convId) as any) : undefined;
			if (sub?.actualModel?.provider) { provider = String(sub.actualModel.provider); modelId = String(sub.actualModel.modelId ?? sub.actualModel.id); }
			if (sub?.thinkingLevel !== undefined && sub?.thinkingLevel !== null) thinkingLevel = String(sub.thinkingLevel);
		}
	}

	if (!provider || !modelId) return {};
	const model = { provider, modelId };
	const modelLabel = thinkingLevel && thinkingLevel !== "off"
		? `assistant turn · ${modelId} (${thinkingLevel})`
		: `assistant turn · ${modelId}`;
	return { model, thinkingLevel, modelLabel };
}

export function recordSubagentOwnership(conversations: RuntimeGraphConversations, current: unknown, rootConvId: string | number): void {
	const doc = (current as any)?.conversation?.docs?.["durable.subagents"];
	if (!doc?.agents) return;
	for (const a of Object.values(doc.agents) as any[]) {
		if (a?.conversationId && a?.ownerTaskId) {
			conversations.recordLogicalOwner(Number(a.conversationId), Number(rootConvId), Number(a.ownerTaskId));
		}
	}
}

export function findSubagentMeta(current: unknown, taskId: number): { readonly name?: string; readonly task?: string } | undefined {
	const doc = (current as any)?.conversation?.docs?.["durable.subagents"];
	if (!doc?.agents) return undefined;
	for (const a of Object.values(doc.agents) as any[]) {
		if (Number(a?.anchorTaskId) === taskId || Number(a?.ownerTaskId) === taskId) {
			return { name: a.name, task: a.task };
		}
	}
	return undefined;
}

export function buildMappedNode(
	node: TaskGraphNode, current: unknown, rootConvId: number,
	names: TaskNames, nativeStartedAt: Map<number, number>, clock: () => number,
): RuntimeTaskNode {
	const id = Number(node.id);
	const convId = Number(node.conversationId);
	const meta = extractTaskModelMeta(node, current, rootConvId);
	const callDetails = names.getDetails(String(id));
	const subMeta = findSubagentMeta(current, id);

	let label = taskLabel(node, names, meta.modelLabel);
	if (node.kind === "durable.subagent-anchor" && subMeta?.name) {
		label = `durable.subagent-anchor · subagent: ${subMeta.name}`;
	}
	if (label.length > MAX_LABEL_LENGTH) label = label.slice(0, MAX_LABEL_LENGTH);

	const startedAt = (node as any).startedAt !== undefined && (node as any).startedAt !== null
		? Number((node as any).startedAt) : nativeStartedAt.get(id);
	const durationMs = startedAt !== undefined ? Math.max(0, clock() - startedAt) : undefined;

	return {
		id, kind: node.kind, conversationId: convId,
		owner: node.owner !== undefined ? Number(node.owner) : undefined,
		background: Boolean(node.background), abortRequested: Boolean(node.abortRequested),
		state: mapTaskGraphNodeState(node.state), blocked: node.blocked, label,
		startedAt, durationMs,
		toolName: callDetails?.toolName ?? (subMeta ? "subagent" : undefined),
		targetHint: callDetails?.targetHint ?? (subMeta ? (subMeta.name || subMeta.task) : undefined),
		model: meta.model, thinkingLevel: meta.thinkingLevel,
		tokens: extractLiveTokens(node, current),
	};
}

export function recordTerminalWithDetails(
	receipts: RuntimeGraphReceiptsCollector,
	task: TaskRecord<unknown, unknown, unknown>,
	names: TaskNames,
	nativeStartedAt: Map<number, number>,
	current?: unknown,
	recentEntries?: ReadonlyMap<number, unknown>,
): void {
	const id = Number(task.id);
	const details = names.getDetails(String(id));
	const subMeta = findSubagentMeta(current, id);
	const toolName = details?.toolName ?? (subMeta ? "subagent" : undefined);
	const targetHint = details?.targetHint ?? (subMeta ? (subMeta.name || subMeta.task) : undefined);
	const preview = subMeta?.task ?? details?.preview ?? names.get(String(id));
	const state = task.state as any;
	const rawEntryId = state?.outcome?.result?.entryId;
	const entryId = rawEntryId !== undefined ? Number(rawEntryId) : undefined;

	receipts.recordTerminal(task, {
		preview, toolName, targetHint, entryId,
		startedAt: nativeStartedAt.get(id),
		tokens: extractTerminalTokens(task, current, recentEntries),
	});
}
