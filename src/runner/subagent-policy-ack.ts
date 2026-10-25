import { defineDoc, type Harness, type JsonObject } from "@earendil-works/pi-durable";
import { subagentPolicyRecordSchema } from "../policy/schema.ts";
import { SubagentPolicyLoadError } from "../policy/errors.ts";
import type { SubagentPolicyHolder, SubagentPolicyRecord } from "../policy/types.ts";
import { createSubagentPolicyHolder } from "./subagent-policy-state.ts";
import { runtimeContext } from "./runtime-types.ts";

export type SubagentPolicyAckState = JsonObject & {
	record: SubagentPolicyRecord | null;
};

export const SubagentPolicyAckDoc = defineDoc<SubagentPolicyAckState>({
	kind: "bb.subagent-policy-ack",
	version: 1,
	scope: "session",
	initial: () => ({ record: null }),
});

export async function loadSubagentPolicyHolder(harness: Harness): Promise<SubagentPolicyHolder> {
	let initialRecord: SubagentPolicyRecord | undefined;

	await harness.commit(async (tx) => {
		const doc = await tx.doc(SubagentPolicyAckDoc);
		if (doc.record !== null && doc.record !== undefined) {
			const parsed = subagentPolicyRecordSchema.safeParse(doc.record);
			if (!parsed.success) {
				throw new SubagentPolicyLoadError("Stored subagent policy ACK is corrupted", {
					cause: parsed.error,
				});
			}
			initialRecord = parsed.data;
		}
	}, runtimeContext);

	return createSubagentPolicyHolder({
		initialRecord,
		persist: async (record: SubagentPolicyRecord) => {
			await harness.commit(async (tx) => {
				const doc = await tx.doc(SubagentPolicyAckDoc);
				doc.record = record;
			}, runtimeContext);
		},
	});
}
