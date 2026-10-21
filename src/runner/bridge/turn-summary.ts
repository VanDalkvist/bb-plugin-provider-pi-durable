import type { DurableView } from "../runtime.ts";
import {
	isAgentDocument,
	isConversationEntryRecord,
	type AgentDocument,
	type ConversationEntryRecord,
	type BBAssistantMessage,
	type CumulativeUsageMetrics,
} from "./contracts.ts";
import {
	buildFinalAssistantMessage,
	extractCumulativeUsage,
} from "./assistant-message-builder.ts";

export interface TurnSummaryResult {
	finalMsg: BBAssistantMessage;
	cw?: number;
	cumulativeUsage?: CumulativeUsageMetrics;
	isAborted: boolean;
	isError: boolean;
	errorMessage?: string;
	lastCheckpointId?: string;
}

export interface SubmissionFault {
	isError: boolean;
	isAborted: boolean;
	errorMessage?: string;
}

export function findSubmissionFault(
	inputs?: readonly (string | number)[],
	submissions?: Map<string | number, { status: string; reason?: string; detail?: string }>,
	lastTaskError?: string,
): SubmissionFault | undefined {
	if (inputs && submissions) {
		for (const id of inputs) {
			const sub = submissions.get(id);
			if (sub && sub.status === "unanswered") {
				const isAborted = sub.reason === "aborted";
				return {
					isAborted,
					isError: !isAborted,
					errorMessage: sub.detail || sub.reason || lastTaskError || "Turn ended with unanswered input",
				};
			}
		}
	}
	if (lastTaskError) {
		return { isAborted: false, isError: true, errorMessage: lastTaskError };
	}
	return undefined;
}

export function resolveTurnSummary(
	current: DurableView,
	currentText: string,
	currentThinking: string,
	lastAssistantMessage?: BBAssistantMessage,
	resolveContextWindow?: (provider?: string, modelId?: string) => number | undefined,
	fault?: SubmissionFault,
): TurnSummaryResult {
	const tail = current?.conversation?.entries?.at(-1);
	const lastCheckpointId = tail?.id !== undefined ? String(tail.id) : undefined;

	const finalMsg = lastAssistantMessage ?? buildFinalAssistantMessage(
		current,
		currentText,
		currentThinking,
	);
	const rawAgentDoc = current?.conversation?.docs?.["pi.agent"];
	const agentDoc: AgentDocument = isAgentDocument(rawAgentDoc) ? rawAgentDoc : {};
	const cw = resolveContextWindow?.(agentDoc.model?.provider, agentDoc.model?.modelId);
	const cumulativeUsage = extractCumulativeUsage(current);

	const entries = current?.conversation?.entries ?? [];
	const lastAssistantEntry = [...entries].reverse().find(
		(e): e is ConversationEntryRecord => isConversationEntryRecord(e) && e.kind === "pi.assistant",
	);
	const firstModelMsg = lastAssistantEntry?.model?.[0];
	const isLastAssistantAborted = Boolean(
		firstModelMsg && "stopReason" in firstModelMsg && (firstModelMsg as { stopReason?: string }).stopReason === "aborted",
	);
	const isAborted = finalMsg.stopReason === "aborted" || isLastAssistantAborted || Boolean(fault?.isAborted);

	const rawLastErr = firstModelMsg && "errorMessage" in firstModelMsg ? (firstModelMsg as { errorMessage?: unknown }).errorMessage : undefined;
	const lastErrStr = typeof rawLastErr === "string" ? rawLastErr : undefined;
	const isLastAssistantError = Boolean(
		(firstModelMsg && "stopReason" in firstModelMsg && (firstModelMsg as { stopReason?: string }).stopReason === "error") ||
		lastErrStr,
	);
	const isError = finalMsg.stopReason === "error" || isLastAssistantError || Boolean(fault?.isError);
	const errorMessage = finalMsg.errorMessage ?? fault?.errorMessage ?? lastErrStr;

	if (isAborted && finalMsg.stopReason !== "aborted") {
		finalMsg.stopReason = "aborted";
	} else if (isError && finalMsg.stopReason !== "error") {
		finalMsg.stopReason = "error";
	}
	if (errorMessage && !finalMsg.errorMessage) {
		finalMsg.errorMessage = errorMessage;
	}

	return { finalMsg, cw, cumulativeUsage, isAborted, isError, errorMessage, lastCheckpointId };
}
