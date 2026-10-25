# Arch Improvement Memory — `bb-plugin-provider-pi-durable`

## 2026-10-12 - Provider Bridge is a Slave Protocol: Subthreads Require Explicit BB Server DB Creation
- Context: Native subagents and composite `providerThreadId` in Beyond Boundaries.
- Symptom: A subagent executed in Pi Durable (`tx.createConversation`), but no child thread appeared in the BB IDE sidebar.
- Cause: The Provider Bridge protocol (`stdio JSON-RPC`) is strictly slave/reactive. Pi creates conversations inside local `session.sqlite`, but BB renders threads exclusively from its internal server SQLite table (`threads`). Without an explicit call to BB Server (`bb.sdk.threads.spawn` or REST API), BB Server has zero knowledge of the subagent, so no sidebar thread exists.
- Use next time: Never assume a provider's local DB entities automatically project into the host UI. Subthread sidebar projection requires an explicit registration call to BB Server API, decoupled from in-process task execution.
- Evidence: Visual inspection in BB IDE; `src/host/bridge.ts` protocol schema; lack of `threads.spawn` calls after PR #9 removal.

## 2026-10-12 - Shared Owner Session Requires Target-Aware Thread Delta Routing
- Context: Reusing `PiThreadSession` across composite thread IDs (`${sessionKey}:${conversationId}`).
- Symptom: If a child thread with ID `thr_child` sends `turn/start`, its deltas would be sent to `thr_parent`.
- Cause: `PiThreadSession` cached `this.options.threadId` from the initial parent connection and blindly routed all runner event deltas to `this.options.threadId`.
- Use next time: In multi-conversation or composite-ID sessions, wire event deltas must map from `event.conversationId` (or active turn threadId) to the specific target `threadId` registered in `SessionRegistry`.
- Evidence: `src/host/session.ts:66` hardcoded `this.sendNotification("thread/delta", { threadId: this.options.threadId, deltas })`.

## 2026-10-12 - Tool Execution Details Stripped in Durable `tool_execution_end`
- Context: Subagent delegation visual cards and `childRef` in timeline deltas.
- Symptom: `childRef` in the delegation card reverted to fallback `"subagent"` instead of the actual `conversationId`.
- Cause: `@earendil-works/pi-durable` deletes `slot.details` when a tool finishes. `tool_execution_end` events lack `details`, causing extractor to return `undefined`.
- Use next time: Buffer `details` (specifically `conversationId`) across `tool_execution_update` events during the tool's lifecycle so `tool_execution_end` retains the conversation metadata.
- Evidence: `src/runner/bridge/tool-result-extractor.ts:74`, `src/host/tool-delta-translator.ts:201`.

## 2026-10-12 - Cycle 86.1: Dual-Track Architecture for Subagents & Subthreads
- Context: Reconciling in-process subagents and BB sidebar child threads without custom socket servers.
- Architectural Resolution:
  1. Native Provider Subagents (Model A): In-process task execution inside `session.sqlite`. Rendered entirely in the parent thread timeline via `DeltaDelegationShape` with real `childRef`. Zero server race conditions or deadlocks.
  2. BB Platform Delegation (Model B): Full independent child threads created via BB platform (`bb thread spawn`), with `providerThreadId: ${sessionKey}:${conversationId}` routed via `SessionRegistry` (Shared Owner) and dynamic delta routing in `PiThreadSession`.
- Verification: 176/176 tests pass, zero type escapes, AP-019 strictly adhered to.

## 2026-10-12 - Subagent BB Subthreads Require Active Mirror Guard to Prevent Duplicate Turn 1 Execution
- Context: Auto-spawning BB sidebar threads on behalf of in-process subagents.
- Symptom: Spawning a subthread in BB causes Turn 1 to execute a duplicate concurrent model generation on the same task.
- Cause: BB Server automatically schedules Turn 1 and dispatches `turn/start` to the Provider Bridge when a thread is created with an initial prompt.
- Use next time: Providers running in-process subagents must implement an Active Mirror Guard in the bridge router. The guard intercepts `turn/start`, verifies if the conversation is an active or completed mirror, acknowledges the turn (`input.accepted`, `turn.open`), and suppresses duplicate `session.prompt`, attaching the thread to the live subagent delta stream instead.
- Evidence: `tests/subagent-parallel-work-check.test.ts`, `src/host/bridge-router.ts:88`, `src/host/subagent-mirror.ts`.

## 2026-10-12 - AP-022: Silent Catch Blocks Mask Critical Runtime Bugs (The version.ts ESM lesson)
- Context: Elimination of empty catch blocks across runner and host modules.
- Symptom: Modules ran with hidden failures that never surfaced in logs or test outputs.
- Cause: Blind `catch {}` blocks were used under the assumption of "safe non-blocking fallback", but in reality they masked broken ESM bindings (`require is not defined`, `__dirname is not defined` in `version.ts`), broken lockfile permissions, and unhandled child process errors.
- Use next time: Strictly obey AP-022. Never write empty `catch {}` or empty `cp.on("error")`. Check specifically for expected non-fatal error codes (e.g., `ENOENT`, `ESRCH`, `EBADF`), and log all other errors with component prefixes and `{ cause }`. When silent catch was replaced in `version.ts`, an ESM bug that existed since Cycle 60 was immediately discovered and resolved.
- Evidence: `src/runner/version.ts`, `tests/session-storage-errors.test.ts`, `docs/arch-improvement/ledger.md` (Cycle 87).

## 2026-10-12 - Host-Side Orchestration vs. Worker CLI Spawning (AP-010 / AP-020 Ports & Adapters)
- Context: Synchronizing in-process Pi Durable subagents with Beyond Boundaries sidebar threads.
- Symptom: Subagent tool tried to spawn external `bb thread spawn` CLI from inside the runner worker process, but failed due to missing CLI environment (`BB_THREAD_ID`, required `--project`), leaving no subthread and violating domain purity.
- Cause: Placing platform orchestration (CLI calls, thread creation) inside execution tool runners couples the domain engine with the host environment.
- Use next time: Strictly follow Ports & Adapters. The runner only emits structured task metadata (`api.details({ conversationId, task })`). The Host Bridge (`src/host/subthread-spawner.ts`), which lives in the BB platform environment, intercepts the event and orchestrates the creation of the child thread, linking it to the active session mirror.
- Evidence: `src/runner/subagent.ts`, `src/host/subthread-spawner.ts`, `tests/host-subthread-spawner.test.ts`, `tests/subagent-timeline-ordering.test.ts`.

## 2026-10-12 - Async Subagents, Role Envelopes & Removing Toy Upstream Limits
- Context: Subagent exploratory loops and blocking parent freezes (Cycle 89).
- Symptom: Child subagent called with level 2 nesting went into a 20-turn exploratory spiral calling `tool_search`, `codemode`, `find`, `git status`, and `read`, freezing the parent chat.
- Cause: Two compounding issues: 1) The upstream example code line `extensions: { remove: [Subagent] }` was copied verbatim, stripping the tool and making nesting impossible; 2) The child conversation was created without a Role Envelope (`instructions`), leading the LLM to think it was the root orchestrator and panic when a tool was absent; 3) `subagent` synchronously blocked on `await submission.wait()`.
- Use next time: Subagents must be non-blocking (`background: true`) by default. Never copy toy demo constraints (`remove: [Subagent]`) into production harnesses. Always configure a strict Role Envelope in `instructions` for child conversations so workers know their boundary, solve the task, and return without triggering exploratory spirals.
- Evidence: `src/runner/subagent.ts`, `tests/subagent-async-envelope.test.ts`, `docs/arch-improvement/ledger.md` (Cycle 89).

## 2026-10-12 - Subagent Delegation Card Single-Source-of-Truth & Child Lifecycle Isolation
- Context: Subagent delegation cards in Beyond Boundaries timeline and end-to-end multi-conversation streaming.
- Symptom: Task prompt repeated twice in parent timeline (at card opening and inside card message body); child subagents in sidebar threads never received streaming deltas or turn boundary completions.
- Cause: 1) `BBChildEventAdapter` forwarded the initial child `message_start` as an assistant `text_delta` under `parentRef`, duplicating what `item.open` already displayed in `summary` and `label`; 2) `BBChildEventAdapter` was missing `conversationId` decoration, preventing Host Bridge from resolving `childThreadId`; 3) Child `run_end` was suppressed, leaving child sidebar threads hanging without `turn.boundary: completed`; 4) Unfiltered forwarding of child `agent_end` to parent translator caused premature parent turn completion.
- Use next time: Keep delegation card summaries clean — never echo user prompts into child text deltas when `summary` already carries the task. Always propagate `conversationId` through child adapters to host bridge. On child `run_end`, emit `agent_end` decorated with `conversationId`, and strictly filter it in `session.ts` so child subthreads complete their turns without prematurely closing the parent turn.
- Evidence: `src/runner/bridge/bb-child-event-adapter.ts`, `src/host/session.ts:167`, `tests/subagent-timeline-ordering.test.ts`, `tests/subagent-dual-stream.test.ts`, `docs/arch-improvement/ledger.md` (Cycle 90).

## 2026-10-12 - Rejection of Declarative Graph DSL: Atomic Primitive Invariant (YAGNI & Unix Philosophy)
- Context: Proposal to add `tasks: string[]` and `chain: string[]` directly into the `subagent` tool schema.
- Symptom: Risk of creating a proprietary, bloated mini-framework/DSL inside the provider harness for task graph execution.
- Cause: Overengineering provider boundaries. LLMs and human orchestrators already possess native multi-tool parallel calls (`tool_calls` fan-out) and sequential nested calls for pipelines.
- Use next time: Keep provider tools atomic (`subagent({ task, background })`). Do not invent custom graph DSLs with string interpolation (`{previous}`) inside the tool runner. The provider's sole responsibility is robust lifecycle, SQLite persistence, and UI streaming; composition belongs to the agent.
- Evidence: `docs/superpowers/specs/2026-10-12-prd-pi-durable-native-subagents-and-composite-threads.md` (Section 6), `docs/arch-improvement/ledger.md` (ADR-90-1).






## 2026-10-20 - AP-026/AP-013: Empty Content Arrays and Missing `status: "failed"` on Wire Bridge Mask Upstream API Faults
- Context: LLM provider turn termination and API failure visibility (Cycle 94).
- Symptom: When upstream APIs timed out (180s) or returned 429/ResourceExhausted, threads in Beyond Boundaries hung during the request and then abruptly went into `idle` without displaying any error banner or text in the UI.
- Cause: 1) Model entries with errors produce `content: []`. The nullish coalescing `msg.content ?? [...]` evaluated to `[]`, omitting `errorMessage`. 2) `translateAgentEnd` blindly mapped all non-aborted runs to `status: "completed"`, completely skipping the provider bridge schema's `status: "failed"` and `error: { message }` payload.
- Use next time: Never allow an assistant message to end with empty content when `stopReason === "error"`. Populate human-readable error text in `content`, preserve `errorMessage` on the wire event, and emit `turn.boundary` with `status: "failed"` and `{ error: { message } }` so the host UI can render the error and offer retry controls.
- Evidence: `tests/error-handling-visibility.test.ts`, `docs/superpowers/plans/2026-10-20-arch-improvement-cycle-94-error-handling-and-failure-visibility.md`, `src/runner/bridge/bb-event-adapter.ts`, `src/host/message-delta-translator.ts`.

## 2026-10-21 - Pi Durable Stores JSON-Encoded Strings in SQLite Indexed Columns (Issue #24)
- Context: Cold offline recovery of subthread bindings in `DurableBindingManager.readOfflineBindings`.
- Symptom: Offline reader silently returned `[]` bindings on real closed `session.sqlite` databases created by Pi Durable SDK.
- Cause: `packages/durable/src/storage/sqlite/storage.ts` uses `encodeIndexedString(value) => JSON.stringify(value)`. In the SQLite `documents` table, `kind` is stored JSON-quoted: `'"bb.native-child-binding"'` (with quotes), while the reader SQL checked `d.kind = 'bb.native-child-binding'`. Hand-written test fixtures inserted unquoted strings, masking the mismatch.
- Use next time: When querying native SQLite stores from Pi Durable, remember that string index columns (`kind`, `requestId`) are JSON-encoded strings. Use `d.kind IN ('val', '"val"')` and ALWAYS test against real SDK-created stores (`openNodeSqliteStorage` + `Harness.open`), not hand-written mock schemas.
- Evidence: `tests/durable-binding-store.test.ts`, `src/host/durable-binding-store.ts`, Issue #24.

## 2026-10-21 - Authoritative Whole-Run Outcome Must Correlate run_end with Input Submissions (Issue #23)
- Context: Translating native terminal run events to BB turn boundary status.
- Symptom: An input submission that settled as `unanswered` (`reason: "faulted"` or `no_model`) was reported to BB as `turn.boundary: { status: "completed" }` if the assistant had emitted prior progress with `stopReason: "toolUse"`.
- Cause: `turn-summary.ts` derived failure solely from assistant message properties (`stopReason === "error"` / `"aborted"`). In a fault after a tool call, the assistant message has `stopReason: "toolUse"`. SDK emits `task_failed`, `turn_end`, `run_end`, and `submission` with `unanswered` in the same transactional batch. `BBEventAdapter` was emitting `agent_end` before correlating matching submission records.
- Use next time: Pre-index transactional event batches (`handleBatch`). In `turn-summary.ts`, correlate `run_end.inputs` with terminal submission records via `findSubmissionFault`. If matching input is `unanswered`, authoritatively set `isError: true` (or `isAborted: true`), emit `turn.boundary: { status: "failed" }`, while preserving prior text progress.
- Evidence: `tests/unanswered-settlement.test.ts`, `src/runner/bridge/turn-summary.ts`, `src/runner/bridge/bb-event-adapter.ts`, Issue #23.

## 2026-10-21 - Arch Improvement Loop Invariant: No Ad-hoc Edits Before S6 Plan
- Context: Process discipline and state machine enforcement.
- Symptom: Agent jumped directly into modifying code upon analyzing an issue without following S0-S6.
- Cause: Over-eagerness to solve the bug quickly bypassed the systematic engineering process.
- Use next time: Strictly obey the Arch Improvement Loop state machine: S0 Bootstrap -> S1 Memory -> S2 Orientation -> S3 Brainstorm & Gate -> S4 Review -> S5 Triage -> S6 Plan Write -> S7 Plan Review -> S8 TDD Execution -> S9 Dual-Circuit Gate -> S10 Ledger -> S11 Memory. Zero code edits before a written and approved plan exists.
- Evidence: Reverted ad-hoc edits, Cycle 99 execution plan `docs/superpowers/plans/2026-10-21-arch-improvement-cycle-99-offline-bindings-and-unanswered-settlement.md`.

## 2026-10-22 - Beyond Boundaries Core Converts Any Parent Tool with Nested Children to Subagent Delegation (Cycle 103)
- Context: Nested tool executions inside `codemode` in Beyond Boundaries timeline.
- Symptom: A turn executing `codemode` was rendered as "Running 1 subagent" / "Ran 1 subagent" with a Bot icon, and `codemode` was converted into a subagent delegation card.
- Cause: In Beyond Boundaries' internal UI engine (`SemanticProjectionBuilder`), any tool whose `callId` appears as `parentToolCallId` in any child tool execution is automatically promoted to `message.kind = "delegation"` and counted as `delegations`. In addition, child rows (`childRows`) are only supported on delegations; if a tool is not a delegation, child rows are dropped. When `codemode` ran nested tools, `BBEventAdapter` unconditionally forwarded `parentToolCallId` as `parentRef`, which triggered BB's delegation converter.
- Use next time: Never forward `parentRef` on wire deltas unless the parent tool is genuinely a delegation (`subagent`, `agent_spawn`, `agent_spawn_graph`). Nested tools run by in-process script engines (`codemode`) must have their `parentRef` suppressed so they stream directly into the timeline as first-class commands/tools. Always provide explicit `presentation` metadata (`icon: { glyph: "Code" }`, `{ pending: "Running code", completed: "Ran code" }`) so the UI does not fall back to generic delegation labels.
- Evidence: `src/host/tool-presentations.ts`, `src/host/tool-item-shape.ts`, `src/runner/bridge/bb-event-adapter.ts`, `tests/codemode-presentation-parity.test.ts`, Issue reported in `thr_bwub2bzpfr`.

## 2026-10-22 - Session Reconcile Options Must Support Mid-Session Dynamic Switching Without Full Restart (Cycle 102)
- Context: Reconciling provider session options (model, thinking level) in `session-commands.ts`.
- Symptom: Changing model or reasoning level in BB UI dropdowns mid-thread had no effect; turns continued with initial model parameters.
- Cause: `reconcileSessionOptions` was a no-op stub that did not propagate dynamic model options to the active `PiThreadSession` / `SessionRegistry`.
- Use next time: Ensure session command handlers dynamically synchronize updated model IDs and thinking levels to runner process state. Write explicit tests asserting that option changes mid-turn alter subsequent prompt parameters without crashing or dropping session state.
- Evidence: `src/runner/session-commands.ts`, `tests/stubs-remediation.test.ts`.

## 2026-10-25 - Native Tool Event Families Alter Payload Channels: Nested Results vs Model Entries (Cycle tool-result-parity)
- Context: Decoding tool execution outcomes and canonical details in Pi Durable.
- Symptom: All successful nested tool executions inside `codemode` or script engines were falsely marked as faulted, patch/diff details were lost in fileChange items, and bash outputs were overwritten.
- Cause: 1) In `@earendil-works/pi-durable`, model-issued calls settle via conversation entries (`event.entry`), while nested tool calls settle directly via task documents (`event.result: NestedToolExecutionResult`), leaving `event.entry === undefined`. The adapter was checking only `event.entry`, treating all nested successes as faults. 2) Details live in `entry.model[0].details` or `result.details`, whereas `entry.data` is merely `{ diagnostics }`. 3) Synthetic fixtures copied `entry` into nested events and put diffs in `entry.data`, concealing the bug. 4) Child adapters that prefix live call IDs (`${parentRef}:${callId}`) must also prefix snapshot-seeded slot IDs upon attachment.
- Use next time: Never assume all tool calls produce conversation entries. Discriminate `entry` vs `result` explicitly. Canonical details live in `model[0].details` or `result.details`, never in `entry.data`. Always test against real SDK producer fixtures (`Harness.open` with `MemoryStorage` and `watchEvents`), and ensure adapter seed keys match live execution prefixing.
- Evidence: `tests/native-tool-projection.test.ts`, `tests/native-tool-result.test.ts`, `src/runner/bridge/native-tool-result.ts`, `src/runner/bridge/tool-progress-state.ts`, PRD `[[prd/2026-10-25-pi-durable-tool-result-parity]]`.

## 2026-10-25 — Native policy identity and producer-derived fixtures
- Canonical durable lesson/implementation record: GBrain `docs/research/pi-durable-subagent-policy-implementation-2026-10-25` (knowledge body stays in the brain; this is the repository execution index).
- Recheck next time: manual BB parenthood is not native child identity; get_state DTO and ROOT_CONVERSATION_ID come from the executed Pi SDK, not a hand-written fixture. Pi 1.3.0 root is 1; an assumed root 0 produced a false corrective test.
- Evidence: `tests/host-mirror-guard-repro.test.ts`, `tests/ui/ui-settings-fixes.test.ts`, both final policy review targeted-closure sections, ledger cycle `subagent-model-policy-2026-10-25`.


