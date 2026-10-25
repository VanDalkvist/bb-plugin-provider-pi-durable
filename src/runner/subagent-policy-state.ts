import { subagentPolicyRecordSchema } from "../policy/schema.ts";
import { SubagentRevisionConflictError } from "../policy/errors.ts";
import type { SubagentPolicyHolder, SubagentPolicyRecord } from "../policy/types.ts";

export interface CreateSubagentPolicyHolderOptions {
	initialRecord?: SubagentPolicyRecord;
	persist: (record: SubagentPolicyRecord) => Promise<void>;
}

export function createSubagentPolicyHolder(options: CreateSubagentPolicyHolderOptions): SubagentPolicyHolder {
	let currentRecord: SubagentPolicyRecord = options.initialRecord
		? subagentPolicyRecordSchema.parse(options.initialRecord)
		: {
				version: 1,
				revision: 0,
				policy: { mode: "inherit" },
			};

	let writeQueue: Promise<void> = Promise.resolve();

	return {
		getRecord(): SubagentPolicyRecord {
			return structuredClone(currentRecord);
		},

		async setRecord(record: SubagentPolicyRecord): Promise<void> {
			const validated = subagentPolicyRecordSchema.parse(record);

			return new Promise<void>((resolve, reject) => {
				writeQueue = writeQueue
					.catch(() => {})
					.then(async () => {
						try {
							if (validated.revision < currentRecord.revision) {
								throw new SubagentRevisionConflictError(
									`Revision downgrade rejected: incoming revision ${validated.revision} < current ${currentRecord.revision}`,
								);
							}

							if (validated.revision === currentRecord.revision) {
								const currentStr = JSON.stringify(currentRecord);
								const incomingStr = JSON.stringify(validated);
								if (currentStr === incomingStr) {
									// Idempotent retry: no-write success
									resolve();
									return;
								}
								throw new SubagentRevisionConflictError(
									`Revision conflict: revision ${validated.revision} already exists with different payload`,
								);
							}

							// validated.revision > currentRecord.revision
							await options.persist(validated);
							currentRecord = validated;
							resolve();
						} catch (error) {
							reject(error);
						}
					});
			});
		},
	};
}
