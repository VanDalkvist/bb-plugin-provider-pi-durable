import type { Context } from "@earendil-works/chord";
import {
	AssistantEntry,
	defineDoc,
	type ConversationId,
	type EntryId,
	type TaskId,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type {
	ResolvedChildConfiguration,
	SubagentModelReference,
	SubagentThinkingLevel,
} from "../policy/types.ts";

export type SubagentRecord = {
	name: string;
	conversationId: ConversationId;
	requestId: string;
	task: string;
	role: string;
	ownerTaskId: TaskId;
	background: boolean;
	reporter?: TaskId;
	report?: string;
	settled?: boolean;
	actualModel?: SubagentModelReference;
	thinkingLevel?: SubagentThinkingLevel;
	source?: ResolvedChildConfiguration["source"];
	policyRevision?: number;
};

export type PendingSubagentReport = {
	id: string;
	name: string;
	text: string;
};

export type SubagentBatchPayload = {
	requestId: string;
	reports: PendingSubagentReport[];
};

export type DeliveryHoldState = {
	kind: "admission" | "uncertain";
	requestId: string;
	reason: string;
};

export type SubagentsState = {
	agents: Record<string, SubagentRecord>;
	outbox?: PendingSubagentReport[];
	courier?: TaskId;
	batchNumber?: number;
	sending?: SubagentBatchPayload;
	deliveryHold?: DeliveryHoldState;
};

export const SubagentsDoc = defineDoc<SubagentsState>({
	kind: "bb.subagents",
	version: 1,
	scope: "conversation",
	checkpointWhen: () => false,
	history: "latest",
	fork: "initial",
	initial: () => ({ agents: {} }),
});

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function extractAssistantText(entry: unknown): string {
	if (!isRecord(entry) || !Array.isArray(entry.model) || entry.model.length === 0) return "";
	const firstMessage = entry.model[0];
	if (!isRecord(firstMessage) || !Array.isArray(firstMessage.content)) return "";
	return firstMessage.content
		.flatMap((p) => (isRecord(p) && p.type === "text" && typeof p.text === "string" ? [p.text] : []))
		.join("");
}

export async function answerText(api: Pick<ToolExecutionApi, "commit">, answer: EntryId, context: Context): Promise<string> {
	const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), context);
	return extractAssistantText(entry);
}
