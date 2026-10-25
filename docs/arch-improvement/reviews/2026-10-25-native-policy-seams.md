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

## Addendum: Tasks 6–7 Seam Proof (Native Pi 1.3 Contracts)

- [P1] Task 7 Native Pi 1.3 `run_end` outcome source & wire DTO translation (AP-012, AP-026, AP-050)
  - Evidence: In `@earendil-works/pi-durable/dist/harness/events.d.ts`, `run_end` is `{ type: "run_end", inputs: readonly SubmissionId[] }` with NO `stopReason`. Task outcomes in Pi 1.3 are emitted via `{ type: "task_failed", taskId, kind, message }` and `{ type: "submission", record: { status: "unanswered", reason } }`. In `bb-child-event-adapter.ts:121`, `task_failed` is dropped by `default: break;`, and `run_end` emits bare `{ type: "agent_end", messages: [] }`. `session.ts:162` then blindly hardcodes `{ kind: "turn.boundary", status: "completed" }` on every `agent_end`, duplicating boundaries and masking failures.
  - Fix: 1) `BBChildEventAdapter` captures `task_failed` (sets `lastFailure`) and `submission` (`unanswered` with `reason === "aborted" | "cancelled"`). On `run_end`, emit wire `agent_end` with `{ type: "agent_end", stopReason: lastFailure ? "error" : (isAborted ? "aborted" : "completed"), errorMessage?: lastFailure?.message }`. 2) In `session.ts:162`, remove hardcoded duplicate boundary; let `childTranslator.translate` generate `turn.boundary` (`completed` | `failed` | `interrupted`). If settlement occurs before the mirror thread is bound, buffered `agent_end` retains outcome for `flushBufferedDeltas`.
  - Fix decision: fix-now (amend plan Task 7).

- [P1] Task 7 Native Pi 1.3 Batch Ordering & Late Binding Terminal Resolution (AP-012, AP-026, AP-035)
  - Ordering proof: In installed `events.js`, `run_end` is pushed BEFORE `submission` records in the same batch. Sequential per-event handling would process `run_end` before seeing `submission.unanswered`, causing false completion. Furthermore, recoverable tool-level `task_failed` must not override a submission that settled `done`.
  - Fix: `BBChildEventAdapter.handleBatch` (fed by `subagent-watcher`) must pre-scan submissions across the batch before emitting `agent_end` for `run_end.inputs`. A `done` submission wins over intermediate tool errors (yielding `completed`). If `unanswered` with `aborted`/`cancelled`, yield `interrupted`. Real order test fixtures: `[run_end, submission(unanswered, reason: aborted)]` -> `interrupted`; `[tool task_failed, run_end, submission done]` -> `completed`.
  - Late binding fix: In `bridge-router.ts:118`, the completed-initial mirror branch calls `registerThread` (flushing buffered deltas including translated terminal boundary) and then synthesizes a redundant hardcoded `completed` boundary. Remove this synthetic duplicate: `flushBufferedDeltas` emits the authoritative terminal boundary preserving actual status (`completed`, `failed`, `interrupted`) exactly once per mirror.
  - Fix decision: fix-now (amend plan Task 7).


- [P1] Task 6 Root guard must precede `registry.reconcileCwd` and check thinking (AP-016, AP-022, AP-027)
  - Evidence: `bridge-router.ts:74` calls `reconcileCwd(params.threadId, targetCwd)` before checking `isRoot` or resolving the child conversation. In `session-registry.ts:72`, `reconcileCwd` calls `await session.closeGracefully()`. A child turn with a different CWD would terminate and reopen the shared root session.
  - Fix: 1) Root check must precede `reconcileCwd`. For child turns (`!isRoot`), bypass `reconcileCwd` (child runs in target conversation context; shared session CWD must not mutate). 2) In child turn guard, if `params.options?.reasoningLevel` or `params.options?.thinkingLevel` is provided, compare against child's actual thinking level (normalizing `"none"` ↔ `"off"`). Reject overrides with JSON-RPC error `-32602` (`CHILD_MODEL_POLICY_LOCKED`).
  - Fix decision: fix-now (amend plan Task 6).

