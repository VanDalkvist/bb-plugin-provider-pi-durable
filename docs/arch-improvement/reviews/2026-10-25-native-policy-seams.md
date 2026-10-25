# S7 Bounded Seam Review: Subagent Model Policy (Tasks 4–6)

Date: 2026-10-25. Plan: `docs/superpowers/plans/2026-10-25-subagent-model-policy.md`.
Baseline: Tasks 1–3 in flight (SDK 0.6.79 exact, store CAS, schemas/resolver).
Scope: Bounded architectural seam check for Tasks 4, 5, 6 before implementation.

## Findings

- [P1] Task 4 Runtime holder wiring and session-commands line budget (AP-011, AP-019, AP-020)
  - Evidence: `harness-setup.ts:68` `createCodingRegistry` takes 4 args; `runtime-loader.ts:98` builds the registry before `Harness.open()`. The plan mistakenly stated `runtime-loader.ts` returns `OpenDurableResult` (it returns `LoadedHarnessEnvironment`). `runtime.ts:172` omitted exposing `subagentPolicyHolder` on `OpenDurableResult`. `session-commands.ts` is currently 199 lines (hard limit AP-019: 200).
  - Fix: Add `subagentPolicyHolder` to `LoadedHarnessEnvironment` and `OpenDurableResult`. Perform bounded extraction of read-only `get_state` and `get_session_stats` into `src/runner/session-state-commands.ts` using the existing `handleBindingCommand` pattern (`handleSessionStateCommand(...): Promise<boolean>`). In `get_state`, query child conversation state cleanly without changing root/current selection via `const conv = await durable.harness.conversation(targetId, BACKGROUND_CONTEXT); const agent = await conv.agent(BACKGROUND_CONTEXT)`.
  - Fix decision: fix-now (amend plan Task 4).

- [P1] Task 4/5 Startup/resume race on persisted owner jobs (AP-013, AP-016, AP-034, AP-035)
  - Evidence: `runtime.ts:167` calls `harness.resume()` before the host connects and sends the first `set_subagent_policy`. If resuming an existing session (`continueSession: true`), active/queued owner tasks execute immediately upon `resume()`. A fresh holder defaulting to `inherit (rev 0)` causes resumed owner tasks to admit subagents under `inherit` instead of the user's configured policy.
  - Fix: Do not delay `harness.resume()` (initialization barrier stalls background tasks if no immediate prompt). Instead, persist an execution ack snapshot in Pi Durable SQLite via `SubagentPolicyAckDoc` (`scope: "session"`, kind `"bb.subagent-policy-ack"`, v1). Before `harness.resume()`, if `!location.created`, read `tx.doc(SubagentPolicyAckDoc)` and seed `subagentPolicyHolder` with the latest acknowledged record. On `set_subagent_policy` command, runner commits the record to `SubagentPolicyAckDoc`. BB KV remains the ONLY user configuration authority; the ack doc is a runtime checkpoint, not a separate config store.
  - Fix decision: fix-now (amend plan Tasks 4 & 5).

- [P2] Task 5 Subagent factory identity and fixture migration (AP-014, AP-024, AP-028)
  - Evidence: `src/runner/subagent.ts` currently exports constant `Subagent: Extension`. Tests (`subagent-courier-delivery.test.ts`, `subagent-error-handling.test.ts`, `subagent-async-envelope.test.ts`, `subagent-auto-spawn.test.ts`) import `Subagent`.
  - Fix: Export `createSubagentExtension(getPolicy: () => SubagentPolicyRecord): Extension` with no module-global mutable state. Retain `export const Subagent = createSubagentExtension(() => ({ revision: 0, mode: "inherit" }))` for zero-breakage fixture compatibility. Extend `SubagentRecord` and `SubagentsDoc` in `subagent-docs.ts` with `actualModel?: ModelRef`, `thinkingLevel?: ModelThinkingLevel`, `source?: "inherit" | "configured"`, `policyRevision?: number`. Emit these fields in `api.details` for observability. Reuse existing child and reporter on replay.
  - Fix decision: fix-now (amend plan Task 5).

- [P1] Task 6 Mirror actual configured model & desired vs ack version tracking (AP-012, AP-016, AP-022)
  - Evidence: When child model differs from parent composer model, `spawnSubthreadInBb` currently omits `--model`, causing BB to inherit the parent model on the child thread. Follow-up turns on the child thread then carry the parent model, causing false `CHILD_MODEL_POLICY_LOCKED` errors or root option mutation. Also, if host initializes acknowledged revision from `session.options.providerOptions.subagentPolicy.revision`, the initial reconcile will compare `desired === ack` and SKIP sending `set_subagent_policy`.
  - Fix: 1) In `session.ts`, initialize `acknowledgedSubagentPolicyRevision?: number = undefined`. Reconcile checks `desired !== acknowledged` and will reliably send initial `set_subagent_policy`. 2) Record child `actualModel` and `thinkingLevel` in `SubagentMirrorRecord` from tool details. 3) Pass `--model` and `--reasoning-level` in `spawnSubthreadInBb`. 4) Guard child turns in `bridge-router.ts`: if `!isRoot`, bypass root session reconcile, match against child `actualModel`, and return `-32602` `CHILD_MODEL_POLICY_LOCKED` only on true overrides.
  - Fix decision: fix-now (amend plan Task 6).

## Plan Amendment Recommendation

Amend Tasks 4–6 in `docs/superpowers/plans/2026-10-25-subagent-model-policy.md` with these 4 bounded contract adjustments before code execution.
VERDICT: Bounded plan amendment recommended (proceed after plan updates).
