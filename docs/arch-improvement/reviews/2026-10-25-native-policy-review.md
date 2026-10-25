# Architecture Review: Native Policy Batch (Commits 43f9362 + 4ba97b0)

**Date:** 2026-10-25  
**Review Target:** `c0ff9ce..4ba97b0` (Commits `43f9362` and `4ba97b0`)  
**Scope:** Tasks 4–5 Native Subagent Policy Runner Integration & S7 Seam Baseline  
**Verdict:** **PASS**

---

## 1. Executive Summary

This independent quality review verifies the frozen native batch implementing Tasks 4 and 5:
- Commit `43f9362`: Native subagent policy runner holder, ACK doc, and execution wiring.
- Commit `4ba97b0`: Remediation of corrupt ACK silent fallback, lifecycle cleanup, and test line budgets.

All 12 focused native policy and ACK tests pass cleanly (`runner-subagent-policy`, `runner-subagent-ack-restore`, `subagent-native-model-application`, `subagent-native-replay-scenarios`). Full test suite reports 368 passing tests. All touched production files strictly adhere to AP-019 (<200 lines, maximum 197 lines).

---

## 2. Parent Finding Remediation Verification (Commit 4ba97b0)

1. **Corrupt ACK Fail-Fast (`AP-012`, `AP-013`):**
   In `src/runner/subagent-policy-ack.ts:24-32`, `loadSubagentPolicyHolder` explicitly validates non-null/non-undefined stored records via `subagentPolicyRecordSchema.safeParse`. Corrupt records throw typed `SubagentPolicyLoadError` preserving the Zod `cause`. Only `null`/`undefined` defaults to `{ version: 1, revision: 0, policy: { mode: "inherit" } }`.
2. **Post-Open Lifecycle Cleanup (`AP-016`, `AP-023`):**
   In `src/runner/runtime-loader.ts:150-165`, `Harness.open` and `loadSubagentPolicyHolder` are guarded in `try ... catch`. On load failure, `harness?.close(runtimeContext)` and `mounted.cleanup?.()` execute via `Promise.allSettled` before rethrowing.
3. **Direct Pi Durable Invocations (`AP-010`):**
   In `src/runner/subagent.ts:102`, background reporter creation uses direct `tx.createTask(DefaultReporter, ...)` without feature probing.
4. **Deterministic Testing & Line Budgets (`AP-019`, `AP-028`):**
   `tests/runner-subagent-ack-restore.test.ts` (81 lines) verifies corrupt ACK rejection against real SQLite storage (`openNodeSqliteStorage`) and `Harness.open`. Tests are split into modular files, all < 200 lines.

---

## 3. Spec & Invariant Conformance Analysis

1. **Per-Runtime Instance Isolation (`AP-034`):**
   `createSubagentPolicyHolder` in `src/runner/subagent-policy-state.ts` creates isolated instances with instance-scoped state (`currentRecord`, `writeQueue`). No module-level mutable singleton.
2. **Serialized Persist-Then-Memory (`AP-013`, `AP-034`, `AP-035`):**
   Updates are serialized on an async promise queue. Memory cache updates strictly follow successful native persistence (`await options.persist(validated); currentRecord = validated;`). Rejection retains the prior valid record and the queue recovers cleanly.
3. **Monotonic Revisions & Idempotency (`AP-035`):**
   Identical same-revision updates resolve idempotently without writes. Lower revisions and same-revision payload mismatches throw `SubagentRevisionConflictError`.
4. **Native ACK Restoration Before Resume (`AP-016`):**
   Restoration occurs in `loadHarnessEnvironment` prior to returning `LoadedHarnessEnvironment`. In `runtime.ts:167`, `harness.resume()` runs only after policy restoration, guaranteeing no subagent is admitted under default policy during session resume.
5. **Required Registry Getter Factory (`AP-011`, `AP-020`):**
   `createCodingRegistry` in `src/runner/harness-setup.ts:70` requires `getSubagentPolicy: () => SubagentPolicyRecord`. No global compatibility singleton.
6. **Targeted Child State Inspection (`AP-011`, `AP-026`):**
   `src/runner/session-state-commands.ts:20-33` reads child state via `durable.harness.conversation(targetId, BACKGROUND_CONTEXT).agent(...)` without modifying root conversation selection or state.
7. **Pure Resolver & Model Preflight (`AP-012`, `AP-027`):**
   `subagent.ts` executes `resolveSubagentModelConfiguration` outside transactions. In configured mode, unavailable models throw `SubagentModelUnavailableError` and unsupported thinking throws `SubagentPolicyInvalidError` fail-fast before child creation.
8. **Role Envelope & Task Separation (`AP-010`, `AP-026`):**
   `buildTechnicalWorkerRole` in `src/runner/subagent-role.ts` provides a static, neutral prompt without task interpolation or git restrictions. Task content is passed strictly as user input.
9. **Tool Parameters Contract (`AP-026`):**
   `subagent` tool schema accepts strictly `task` and `background`. No LLM model overrides or host fallback properties leaked into the agent tool surface. Anchor and DefaultCourier semantics remain intact.

---

## 4. Concurrency & Race Analysis (Lookup vs Rescan)

In `src/runner/subagent.ts:40-92`:
- **First Lookup:** In-memory check against `SubagentsDoc` skips model resolution and conversation creation during replay.
- **Durable Commit Double-Check:** Inside `api.commit` (ACID SQLite transaction), `state?.agents?.[key]` is checked again.
- **Conversation Ownership Recovery:** If absent from doc, `tx.scanConversations({ ownerTaskId: api.taskId }, 1)` ensures prior interrupted/crashed attempts reuse the existing conversation rather than duplicating it.
- **Race Evaluation:** Because Pi Durable transaction commits serialize on the SQLite transaction lock, concurrent admissions for the same `taskId` cannot produce conflicting state. No legitimate race condition exists.

---

## 5. Findings & Observations

- **[P3] Type hygiene in session-commands:**
  - *Evidence:* `src/runner/session-commands.ts:119-120` casts `(cmd as any).policy` and `record as any`.
  - *Impact:* Safe at runtime because `setRecord` invokes strict Zod parsing (`subagentPolicyRecordSchema.parse`), but `as any` bypasses compile-time type verification.
  - *Rule:* AP-026 (Contract Integrity).
  - *Fix decision:* fix-later (P3 hygiene: type `RunnerCommandPayload.policyRecord` as `SubagentPolicyRecord | unknown` and accept `unknown` in `setRecord`).

---

## 6. Architecture Verification & Residuals

### Architecture verification
- Passed: `AP-010`, `AP-011`, `AP-012`, `AP-013`, `AP-014`, `AP-016`, `AP-019`, `AP-020`, `AP-022`, `AP-023`, `AP-026`, `AP-027`, `AP-028`, `AP-034`, `AP-035`, `AP-038`.
- Not applicable: `AP-030`, `AP-040` (storage migrations / remote network adapters not touched in this runner slice).
- Residual risk: Host Tasks 6–7 remain to be integrated concurrently (root option reconciliation, mirror isolation, and outcome boundary streaming).

VERDICT: PASS
