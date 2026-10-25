import type { ConversationId } from "@earendil-works/pi-durable";
import { BindingDoc, BindingIndexDoc, identityKey, type StoredBinding } from "./binding-docs.ts";
import { runtimeContext, type OpenDurableResult } from "./runtime-types.ts";
import type { CommandResponder, RunnerCommandPayload } from "../contracts/runner-command.ts";

function toConversationId(id: unknown): ConversationId | undefined {
	if (typeof id === "number" && Number.isInteger(id) && id > 0) {
		return id as ConversationId;
	}
	if (typeof id === "string" && id.trim()) {
		const num = Number(id.trim());
		if (Number.isInteger(num) && num > 0) {
			return num as ConversationId;
		}
	}
	return undefined;
}

export async function handleBindingCommand(
	cmd: RunnerCommandPayload,
	durable: OpenDurableResult,
	responder: CommandResponder,
): Promise<boolean> {
	if (cmd.type === "register_binding") {
		if (
			typeof cmd.bbThreadId !== "string" ||
			!cmd.bbThreadId.trim() ||
			cmd.conversationId === undefined ||
			cmd.conversationId === null
		) {
			responder.error(cmd.id, "register_binding", "Missing bbThreadId or conversationId");
			return true;
		}
		const bbThreadId = cmd.bbThreadId.trim();
		const convId = toConversationId(cmd.conversationId);
		if (convId === undefined) {
			responder.error(cmd.id, "register_binding", `Invalid conversationId: ${String(cmd.conversationId)}`);
			return true;
		}

		try {
			await durable.harness.commit(async (tx) => {
				const index = await tx.doc(BindingIndexDoc);
				const state = await tx.doc(BindingDoc, convId);
				const sessionId = durable.view.current()?.session?.id ?? "default";
				const parentThreadId = typeof cmd.parentThreadId === "string" && cmd.parentThreadId.trim()
					? cmd.parentThreadId.trim()
					: null;
				const record: StoredBinding = {
					providerId: "pi-durable",
					sessionId,
					conversationId: convId,
					bbThreadId,
					parentThreadId,
					createdAt: Date.now(),
				};
				state.binding = record;
				index.byThreadId[bbThreadId] = convId;
				const key = identityKey(record);
				index.byIdentity[key] = convId;
			}, runtimeContext);
			responder.success(cmd.id, "register_binding", { registered: true });
		} catch (err) {
			responder.error(cmd.id, "register_binding", err instanceof Error ? err.message : String(err));
		}
		return true;
	}

	if (cmd.type === "get_all_bindings") {
		try {
			const index = await durable.harness.snapshot(BindingIndexDoc, runtimeContext);
			const bindings: StoredBinding[] = [];
			if (index?.byThreadId) {
				const convIds = new Set<ConversationId>(Object.values(index.byThreadId));
				for (const convId of convIds) {
					try {
						const state = await durable.harness.snapshot(BindingDoc, convId, runtimeContext);
						if (state?.binding) {
							bindings.push(state.binding);
						}
					} catch (err) {
						console.warn(`[BindingCommands] Failed to read BindingDoc for conversation ${convId}: ${err}`);
					}
				}
			}
			responder.success(cmd.id, "get_all_bindings", { bindings });
		} catch (err) {
			responder.error(cmd.id, "get_all_bindings", err instanceof Error ? err.message : String(err));
		}
		return true;
	}

	return false;
}
