import type { Context } from "@earendil-works/chord";
import type { ConversationHandle, ConversationId, Extension, Task } from "@earendil-works/pi-durable";

export type SubagentAdmission = (child: ConversationHandle, requestId: string, context: Context) => Promise<void>;
export type Admission = (conversation: ConversationHandle, requestId: string, context: Context) => Promise<void>;
export type ReporterInput = { key: string; conversationId: ConversationId; task: string; requestId: string };
export type ReporterState = { phase: "deliver" } | { phase: "report"; text: string };
export type CourierState = { phase: "gather" | "next" | "send" | "hold" };

export type CourierTask = Task<null, CourierState, null, object>;
export type ReporterTask = Task<ReporterInput, ReporterState, null, object>;
export type SubagentTaskExtension<I, S extends { phase: string }, R, H extends object = object> = Task<I, S, R, H> & Extension;
