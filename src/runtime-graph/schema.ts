import { z } from "zod";

export const MAX_LIVE_NODES = 512;
export const MAX_RECEIPTS = 128;
export const MAX_LABEL_LENGTH = 160;
export const MAX_PREVIEW_LENGTH = 500;
export const MAX_SNAPSHOT_BYTES = 1048576; // 1 MiB

export const TASK_OUTCOMES = ["completed", "failed", "aborted", "faulted", "orphaned"] as const;
export const taskOutcomeSchema = z.enum(TASK_OUTCOMES);

export const LIVE_TASK_STATUSES = ["pending", "running", "waiting", "sleeping", "completing"] as const;
export const liveTaskStatusSchema = z.enum(LIVE_TASK_STATUSES);

export const BLOCKED_REASONS = ["missing_task", "task_too_old", "migration_failed", "restart_limit"] as const;
export const blockedReasonSchema = z.enum(BLOCKED_REASONS);

export const graphScopeSchema = z.object({
	sessionId: z.string().min(1).max(256),
	rootConversationId: z.string().min(1).max(64),
	buildId: z.string().min(1).max(64),
});

export const graphObservationSchema = z.object({
	epoch: z.string().min(1).max(64),
	revision: z.number().int().nonnegative(),
	observedAt: z.number().int().positive(),
	completeness: z.enum(["complete", "limited"]),
});

export const runtimeTaskStateSchema = z.discriminatedUnion("status", [
	z.object({
		status: z.literal("pending"),
		phase: z.string().max(64).optional(),
	}),
	z.object({
		status: z.literal("running"),
		phase: z.string().max(64).optional(),
	}),
	z.object({
		status: z.literal("waiting"),
		phase: z.string().max(64).optional(),
		on: z.array(z.number().int().positive()).max(MAX_LIVE_NODES),
		policy: z.enum(["failFast", "allSettled", "all", "first"]).optional(),
	}),
	z.object({
		status: z.literal("sleeping"),
		phase: z.string().max(64).optional(),
		until: z.number().int().positive(),
	}),
	z.object({
		status: z.literal("completing"),
		outcome: taskOutcomeSchema,
	}),
]);

export const runtimeTaskNodeSchema = z.object({
	id: z.number().int().positive(),
	kind: z.string().min(1).max(64),
	conversationId: z.number().int().positive(),
	owner: z.number().int().positive().optional(),
	background: z.boolean(),
	abortRequested: z.boolean(),
	state: runtimeTaskStateSchema,
	blocked: blockedReasonSchema.optional(),
	label: z.string().min(1).max(MAX_LABEL_LENGTH),
	startedAt: z.number().int().positive().optional(),
	endedAt: z.number().int().positive().optional(),
	durationMs: z.number().int().nonnegative().optional(),
});

export const runtimeConversationNodeSchema = z.object({
	id: z.number().int().positive(),
	owner: z
		.object({
			conversationId: z.number().int().positive(),
			taskId: z.number().int().positive(),
		})
		.optional(),
	parent: z
		.object({
			conversationId: z.number().int().positive(),
			at: z.number().int().positive(),
		})
		.optional(),
});

export const runtimeTaskReceiptSchema = z.object({
	taskId: z.number().int().positive(),
	conversationId: z.number().int().positive(),
	owner: z.number().int().positive().optional(),
	kind: z.string().min(1).max(64),
	outcome: taskOutcomeSchema,
	isToolError: z.boolean().optional(),
	error: z
		.object({
			message: z.string().max(1024),
			code: z.string().max(64).optional(),
		})
		.optional(),
	endedAt: z.number().int().positive(),
	durationMs: z.number().int().nonnegative().optional(),
	preview: z.string().max(MAX_PREVIEW_LENGTH).optional(),
});

export const runtimeGraphStatsSchema = z.object({
	liveCount: z.number().int().nonnegative(),
	terminalCount: z.number().int().nonnegative(),
	totalCount: z.number().int().nonnegative(),
});

export function getUtf8ByteLength(str: string): number {
	if (typeof Buffer !== "undefined") {
		return Buffer.byteLength(str, "utf8");
	}
	if (typeof TextEncoder !== "undefined") {
		return new TextEncoder().encode(str).length;
	}
	let bytes = 0;
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i);
		if (code <= 0x7f) bytes += 1;
		else if (code <= 0x7ff) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff) {
			bytes += 4;
			i++;
		} else bytes += 3;
	}
	return bytes;
}

export const runtimeGraphSnapshotSchema = z
	.object({
		version: z.literal(1),
		scope: graphScopeSchema,
		observation: graphObservationSchema,
		nodes: z
			.record(z.string(), runtimeTaskNodeSchema)
			.refine((nodes) => Object.keys(nodes).length <= MAX_LIVE_NODES, {
				message: `Live nodes exceed maximum of ${MAX_LIVE_NODES}`,
			}),
		conversations: z.record(z.string(), runtimeConversationNodeSchema),
		receipts: z.array(runtimeTaskReceiptSchema).max(MAX_RECEIPTS),
		stats: runtimeGraphStatsSchema,
	})
	.refine(
		(snapshot) => {
			// Fast estimate check for 1MiB payload ceiling
			try {
				const json = JSON.stringify(snapshot);
				return getUtf8ByteLength(json) <= MAX_SNAPSHOT_BYTES;
			} catch {
				return false;
			}
		},
		{ message: "Runtime graph snapshot exceeds 1 MiB payload limit" },
	);
