/**
 * Public DTO types for Pi Durable Runtime Task Graph.
 * Pure TypeScript types at the adapter boundary.
 */

export type TaskOutcomeName = "completed" | "failed" | "aborted" | "faulted" | "orphaned";

export type LiveTaskStatus = "pending" | "running" | "waiting" | "sleeping" | "completing";

export type BlockedTaskReason = "missing_task" | "task_too_old" | "migration_failed" | "restart_limit";

export interface GraphScope {
	readonly sessionId: string;
	readonly rootConversationId: string;
	readonly buildId: string;
}

export interface GraphObservation {
	readonly epoch: string;
	readonly revision: number;
	readonly observedAt: number;
	readonly completeness: "complete" | "limited";
}

export type RuntimeTaskState =
	| {
			readonly status: "pending";
			readonly phase?: string;
	  }
	| {
			readonly status: "running";
			readonly phase?: string;
	  }
	| {
			readonly status: "waiting";
			readonly phase?: string;
			readonly on: readonly number[];
			readonly policy?: "failFast" | "allSettled" | "all" | "first";
	  }
	| {
			readonly status: "sleeping";
			readonly phase?: string;
			readonly until: number;
	  }
	| {
			readonly status: "completing";
			readonly outcome: TaskOutcomeName;
	  };

export interface RuntimeTaskNode {
	readonly id: number;
	readonly kind: string;
	readonly conversationId: number;
	readonly owner?: number;
	readonly background: boolean;
	readonly abortRequested: boolean;
	readonly state: RuntimeTaskState;
	readonly blocked?: BlockedTaskReason;
	readonly label: string;
	readonly startedAt?: number;
	readonly endedAt?: number;
	readonly durationMs?: number;
}

export interface RuntimeConversationNode {
	readonly id: number;
	readonly owner?: {
		readonly conversationId: number;
		readonly taskId: number;
	};
	readonly parent?: {
		readonly conversationId: number;
		readonly at: number;
	};
}

export interface RuntimeTaskReceipt {
	readonly taskId: number;
	readonly conversationId: number;
	readonly owner?: number;
	readonly kind: string;
	readonly outcome: TaskOutcomeName;
	readonly isToolError?: boolean;
	readonly error?: {
		readonly message: string;
		readonly code?: string;
	};
	readonly endedAt: number;
	readonly durationMs?: number;
	readonly preview?: string;
}

export interface RuntimeGraphStats {
	readonly liveCount: number;
	readonly terminalCount: number;
	readonly totalCount: number;
}

export interface RuntimeGraphSnapshot {
	readonly version: 1;
	readonly scope: GraphScope;
	readonly observation: GraphObservation;
	readonly nodes: Readonly<Record<string, RuntimeTaskNode>>;
	readonly conversations: Readonly<Record<string, RuntimeConversationNode>>;
	readonly receipts: readonly RuntimeTaskReceipt[];
	readonly stats: RuntimeGraphStats;
}

export interface ProjectedTaskState {
	readonly rawStatus: LiveTaskStatus;
	readonly label: string;
	readonly isFinal: boolean;
	readonly isCompleting?: boolean;
	readonly abortRequested?: boolean;
	readonly sleepUntil?: number;
	readonly waitingOn?: readonly number[];
	readonly blockedReason?: BlockedTaskReason;
}

export interface ProjectedReceiptState {
	readonly outcome: TaskOutcomeName;
	readonly isFinal: true;
	readonly hasToolError: boolean;
	readonly label: string;
	readonly preview?: string;
	readonly endedAt: number;
	readonly durationMs?: number;
}
