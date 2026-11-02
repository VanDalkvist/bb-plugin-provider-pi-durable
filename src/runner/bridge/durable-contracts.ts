/**
 * Durable SQLite Document Schemas & Type Guards (AP-026, AP-029).
 */
import { NestedCallDoc } from "@earendil-works/pi-durable";

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

export type ConversationEntryRecord = import("@earendil-works/pi-durable").EntryRecord;
export type NestedToolExecutionResult = import("@earendil-works/pi-durable").NestedToolExecutionResult;

export interface ContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
	[key: string]: unknown;
}

export interface ToolSlotRecord {
	callId: string | number;
	output?: unknown;
	details?: unknown;
	[key: string]: unknown;
}

export type MessageChange =
	| { type: "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number; block: ContentBlock }
	| { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_delta"; contentIndex: number; path: readonly (string | number)[]; delta: string }
	| { type: "block"; contentIndex: number; block: ContentBlock }
	| { type: "message"; message: unknown };

export type ToolEventCall = {
	toolCallId: string;
	toolName: string;
	taskId?: string | number;
	parentToolCallId?: string;
	parentTaskId?: string | number;
};

export type SnapshotEvent = {
	type: "snapshot";
	entries: readonly ConversationEntryRecord[];
	run?: { inputs: readonly (string | number)[] };
	generation?: {
		attempt: number;
		message?: unknown;
		retry?: { at: number; error: string };
		deferred?: { pollAt: number };
	};
	tools: readonly ToolSlotRecord[];
	nestedTools: readonly ToolSlotRecord[];
	compactions: readonly unknown[];
	compactionFailure?: unknown;
	inbox: readonly unknown[];
	agent: unknown;
	usage: unknown;
};

export type AgentEvent =
	| SnapshotEvent
	| { type: "run_start"; inputs: readonly (string | number)[] }
	| { type: "run_end"; inputs: readonly (string | number)[] }
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "message_start"; message: unknown }
	| { type: "message_update"; usage: unknown; changes: readonly MessageChange[] }
	| { type: "message_end"; entry: ConversationEntryRecord }
	| ({ type: "tool_execution_start"; args: Record<string, unknown> } & ToolEventCall)
	| ({
			type: "tool_execution_update";
			output?: { trimStart?: number; append?: string } | { set: string };
			details?: unknown;
			diagnostics?: readonly unknown[];
	  } & ToolEventCall)
	| ({ type: "tool_execution_end"; entry?: ConversationEntryRecord; result?: NestedToolExecutionResult } & ToolEventCall)
	| { type: "inbox_update"; items: readonly unknown[] }
	| { type: "submission"; record: unknown }
	| { type: "auto_retry_start"; attempt: number; at: number; errorMessage: string }
	| { type: "auto_retry_end"; attempt: number }
	| { type: "deferred_poll"; pollAt: number }
	| { type: "entry_appended"; entry: ConversationEntryRecord }
	| { type: "agent_changed"; agent: unknown }
	| { type: "usage_changed"; usage: unknown }
	| { type: "task_failed"; taskId: string | number; kind: string; message: string }
	| { type: "compaction_start"; taskId: string | number; reason: unknown; blocking: boolean }
	| { type: "compaction_end"; taskId: string | number; reason: unknown; error?: string };

export interface AgentEventStream {
	readonly snapshot: SnapshotEvent;
	start(listener: (events: readonly AgentEvent[], context: unknown) => Promise<void>): void;
	stop(): Promise<unknown>;
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
