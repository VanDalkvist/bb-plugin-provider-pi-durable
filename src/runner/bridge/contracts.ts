/**
 * Wire contracts and DTO schemas for Beyond Boundaries (BB IDE) RPC integration.
 * In accordance with AP-026 (DTO boundaries & strict schema validation) and AP-029 (Zero any casts).
 */

export interface BBToolExecutionStartEvent {
	type: "tool_execution_start";
	toolCallId: string | number;
	toolName: string;
	args: Record<string, unknown>;
}

export interface BBToolExecutionUpdateEvent {
	type: "tool_execution_update";
	toolCallId: string | number;
	toolName: string;
	partialResult: string;
	trimStart?: number;
}

export interface BBToolExecutionEndEvent {
	type: "tool_execution_end";
	toolCallId: string | number;
	toolName: string;
	result: string;
	isError: boolean;
	details?: unknown;
}

export interface BBThinkingDeltaEvent {
	type: "message_update";
	assistantMessageEvent: { type: "thinking_delta"; contentIndex: 0; delta: string };
}

export interface BBThinkingEndEvent {
	type: "message_update";
	assistantMessageEvent: { type: "thinking_end"; contentIndex: 0; content: string };
}

export interface BBTextDeltaEvent {
	type: "message_update";
	assistantMessageEvent: { type: "text_delta"; contentIndex: number; delta: string };
}

export type BBMessageUpdateEvent = BBThinkingDeltaEvent | BBThinkingEndEvent | BBTextDeltaEvent;

export interface BBAssistantMessageUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
	};
}

export interface BBAssistantMessage {
	role: "assistant";
	content: Array<
		| { type: "text"; text: string }
		| { type: "thinking"; thinking: string }
		| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
	>;
	stopReason?: "stop" | "toolUse" | "length" | "aborted" | "error";
	usage?: BBAssistantMessageUsage;
}

export interface BBAgentStartEvent { type: "agent_start"; }
export interface BBTurnStartEvent { type: "turn_start"; }

export interface CumulativeUsageMetrics {
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens?: number;
	cacheWriteInputTokens?: number;
}

export interface BBTurnEndEvent {
	type: "turn_end";
	message?: BBAssistantMessage;
	contextWindow?: number;
	providerCheckpointId?: string;
	cumulativeUsage?: CumulativeUsageMetrics;
}

export interface BBMessageEndEvent {
	type: "message_end";
	message: BBAssistantMessage;
}

export interface BBAgentEndEvent {
	type: "agent_end";
	messages: BBAssistantMessage[];
	providerCheckpointId?: string;
	contextWindow?: number;
	cumulativeUsage?: CumulativeUsageMetrics;
}

export interface BBCompactionStartEvent {
	type: "compaction_start";
	reason: "manual" | "threshold";
}

export interface BBCompactionEndEvent {
	type: "compaction_end";
	reason: "manual" | "threshold";
	aborted: boolean;
}

export interface BBAutoRetryStartEvent {
	type: "auto_retry_start";
	attempt: number;
	at?: number;
	errorMessage?: string;
}

export interface BBAutoRetryEndEvent {
	type: "auto_retry_end";
	attempt: number;
	success?: boolean;
}

export interface BBSessionStatsData {
	contextUsage: { tokens: number; contextWindow: number };
}

export type BBWireEvent =
	| BBAgentStartEvent
	| BBTurnStartEvent
	| BBMessageUpdateEvent
	| BBToolExecutionStartEvent
	| BBToolExecutionUpdateEvent
	| BBToolExecutionEndEvent
	| BBMessageEndEvent
	| BBTurnEndEvent
	| BBAgentEndEvent
	| BBCompactionStartEvent
	| BBCompactionEndEvent
	| BBAutoRetryStartEvent
	| BBAutoRetryEndEvent;

// Durable SQLite Document Schemas & Type Guards (AP-026, AP-029)

export interface AgentDocument {
	model?: { provider?: string; modelId?: string };
}

export interface UsageDocument {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	models?: Record<string, unknown>;
	tools?: Record<string, unknown>;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
	};
	[key: string]: unknown;
}

export interface ToolArgumentsDocument {
	[key: string]: unknown;
}

export interface ToolCallBlock {
	type: string;
	id?: string;
	callId?: string;
	arguments?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface ConversationEntryRecord {
	readonly id: number;
	readonly conversationId: number;
	kind?: string;
	model?: Array<{
		role?: string;
		isError?: boolean;
		content?: unknown;
		stopReason?: string;
		usage?: BBAssistantMessageUsage;
		[key: string]: unknown;
	}>;
	[key: string]: unknown;
}

export interface LiveToolSlotRecord {
	id?: string | number;
	callId?: string;
	args?: Record<string, unknown>;
	[key: string]: unknown;
}

export function isAgentDocument(doc: unknown): doc is AgentDocument {
	return typeof doc === "object" && doc !== null;
}

export function isUsageDocument(doc: unknown): doc is UsageDocument {
	return typeof doc === "object" && doc !== null;
}

export function isToolCallBlock(block: unknown): block is ToolCallBlock {
	return typeof block === "object" && block !== null && (block as ToolCallBlock).type === "toolCall";
}

export function isConversationEntryRecord(entry: unknown): entry is ConversationEntryRecord {
	return typeof entry === "object" && entry !== null;
}
