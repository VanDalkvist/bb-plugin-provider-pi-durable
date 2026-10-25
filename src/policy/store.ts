import {
  SUBAGENT_POLICY_KV_KEY,
  subagentPolicyRecordSchema,
  subagentPolicySchema,
} from "./schema.ts";
import type { SubagentPolicy, SubagentPolicyRecord } from "./types.ts";
import {
  SubagentPolicyLoadError,
  SubagentRevisionConflictError,
} from "./errors.ts";

export interface SubagentKvAdapter {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export interface SubagentPolicyStoreOptions {
  clock?: () => string;
}

export class SubagentPolicyStore {
  private readonly kv: SubagentKvAdapter;
  private readonly clock: () => string;
  private currentRecord: SubagentPolicyRecord | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(kv: SubagentKvAdapter, options?: SubagentPolicyStoreOptions) {
    this.kv = kv;
    this.clock = options?.clock ?? (() => new Date().toISOString());
  }

  public async hydrate(): Promise<SubagentPolicyRecord> {
    let raw: unknown;
    try {
      raw = await this.kv.get(SUBAGENT_POLICY_KV_KEY);
    } catch (error) {
      throw new SubagentPolicyLoadError(
        "Failed to read subagent policy from storage",
        { cause: error }
      );
    }

    if (raw === undefined) {
      const defaultRecord: SubagentPolicyRecord = {
        version: 1,
        revision: 0,
        policy: { mode: "inherit" },
      };
      this.currentRecord = defaultRecord;
      return structuredClone(defaultRecord);
    }

    const parsed = subagentPolicyRecordSchema.safeParse(raw);
    if (!parsed.success) {
      throw new SubagentPolicyLoadError(
        "Stored subagent policy is corrupted",
        { cause: parsed.error }
      );
    }

    this.currentRecord = parsed.data;
    return structuredClone(this.currentRecord);
  }

  public getRecord(): SubagentPolicyRecord {
    if (!this.currentRecord) {
      throw new SubagentPolicyLoadError("Subagent policy store is not hydrated");
    }
    return structuredClone(this.currentRecord);
  }

  public async setPolicy(
    policy: SubagentPolicy,
    expectedRevision: number
  ): Promise<SubagentPolicyRecord> {
    const validatedPolicy = subagentPolicySchema.parse(policy);

    return new Promise<SubagentPolicyRecord>((resolve, reject) => {
      this.writeQueue = this.writeQueue
        .catch(() => {})
        .then(async () => {
          try {
            if (!this.currentRecord) {
              throw new SubagentPolicyLoadError(
                "Subagent policy store is not hydrated"
              );
            }
            if (expectedRevision !== this.currentRecord.revision) {
              throw new SubagentRevisionConflictError(
                `Revision conflict: expected revision ${expectedRevision}, but current revision is ${this.currentRecord.revision}`
              );
            }

            const newRecord: SubagentPolicyRecord = {
              version: 1,
              revision: this.currentRecord.revision + 1,
              updatedAt: this.clock(),
              policy: validatedPolicy,
            };

            subagentPolicyRecordSchema.parse(newRecord);
            await this.kv.set(SUBAGENT_POLICY_KV_KEY, newRecord);

            this.currentRecord = structuredClone(newRecord);
            resolve(structuredClone(newRecord));
          } catch (error) {
            reject(error);
          }
        });
    });
  }
}
