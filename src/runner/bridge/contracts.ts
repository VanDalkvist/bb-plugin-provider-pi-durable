/**
 * Wire contracts and DTO schemas for Beyond Boundaries (BB IDE) RPC integration.
 * In accordance with AP-026 (DTO boundaries & strict schema validation).
 */

export interface BBToolExecutionStartEvent {
	type: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
}

export interface BBToolExecutionUpdateEvent {
	type: "tool_execution_update";
	toolCallId: string;
	toolName: string;
	partialResult: unknown;
}

export interface BBToolExecutionEndEvent {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: unknown;
	isError: boolean;
}

export interface BBThinkingDeltaEvent {
	type: "message_update";
	assistantMessageEvent: {
		type: "thinking_delta";
		contentIndex: 0;
		delta: string;
	};
}

export interface BBTextDeltaEvent {
	type: "message_update";
	assistantMessageEvent: {
		type: "text_delta";
		contentIndex: number;
		delta: string;
	};
}

export type BBMessageUpdateEvent = BBThinkingDeltaEvent | BBTextDeltaEvent;


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

export interface BBAgentStartEvent {
	type: "agent_start";
}

export interface BBTurnStartEvent {
	type: "turn_start";
}

export interface BBTurnEndEvent {
	type: "turn_end";
	message?: BBAssistantMessage;
	contextWindow?: number;
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

export interface BBSessionStatsData {
	contextUsage: {
		tokens: number;
		contextWindow: number;
	};
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
	| BBCompactionEndEvent;

