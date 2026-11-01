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

## 2026-10-25 — Native edit display diff is not the patch contract
- Canonical lesson: GBrain `docs/research/pi-durable-native-edit-file-change-micro-loop-2026-10-25` (knowledge body stays in the brain).
- Recheck next time: file identity follows args.path, not replacement-region count; native details.patch is canonical, details.diff is TUI display. Protect semantics with real producer plus exact patch application, not schema acceptance alone.
- Evidence: `f11f89d`, `tests/native-edit-file-change.test.ts`, both delta acceptance reports, ledger cycle `file-change-delta-2026-10-25`.

## 2026-10-27 - Background Subagent Ownership Invariant: Anchor Task vs Foreground Tool Task
- Context: Spawning background subagents in Pi Durable (`src/runner/subagent.ts`).
- Symptom: Spawning a background subagent (`background: true`) caused the parent conversation to freeze for 15+ minutes in `status: "waiting"`, unable to answer the user or accept input, triggering BB Core's 120s `provider_turn_start_timeout` watchdog.
- Cause: Assigning conversation ownership to the caller tool task (`ownership: { kind: "task", taskId: api.taskId }`). Under Pi Durable Spec §5.5 Rule 4, a task cannot become `terminal` while any owned task is live (`#hasOwnedLive`). Because `api.taskId` owned the child conversation, the tool task was held in `completing` for the entire lifetime of the subagent, and the parent `pi.generation` was held in `waiting`, completely locking the parent conversation.
- Use next time: Strictly follow Pi Durable's background canon (`test/examples/23-subagent-background.ts`). A background conversation must be owned by an `Anchor` task (`{ ownership: { kind: "conversation" }, background: true }`). This allows the foreground tool task to settle immediately to `terminal` in milliseconds, returning the parent conversation to `idle`, while the subagent runs asynchronously in the background. On the wire bridge, also emit `{ kind: "turn.open" }` on root input acceptance to disarm BB Core's 120s watchdog timer.
- Evidence: `tests/subagent-background-unblock.test.ts`, `tests/turn-start-watchdog-prevention.test.ts`, `src/runner/subagent.ts`, `src/host/bridge-router.ts`.

## 2026-10-29 - Task Graph Chronology Invariant: Freshest Work Strictly at the Top (b.id - a.id)
- Context: Task list presentation and history folding in Beyond Boundaries Task Graph.
- Symptom: Long-running threads displayed tasks in ascending ID order (`a.id - b.id`), showing initial stale turns (#1..#5) at the top, while the latest work (#100+) was pushed down or hidden under `See more`.
- Cause: `sortTreeActiveFirst`, `renderBranch`, and `computePreviewFinishedIds` were implemented with `a.id - b.id` (ascending). In an agentic IDE, the user's focus is on the most recent turns and active progress.
- Use next time: Task graphs and activity trees must order finished tasks in reverse chronology (`b.id - a.id`, newest at the top). History preview slices must pick the `targetFinishedCount` most recent items, folding older turns under `See more` at the bottom of the list.
- Evidence: `src/ui/runtime-graph/tree-order.ts`, `src/ui/runtime-graph/tree-preview.ts`, `src/ui/runtime-graph/tree.tsx`, `tests/ui/runtime-graph-preview.test.ts`, Cycle 85.

## 2026-10-29 - Tabular Alignment and Token Delta Invariant (Cycle 86)
- Context: Task row metrics presentation (tokens and durations).
- Symptom: Varying character lengths of total tokens (`178k tok`, `1.4k tok`) and durations (`4.4s`, `121.9s`) caused horizontal wobbling ("волнами туда-сюда"), and displaying cumulative context window size hid the actual per-step cost.
- Cause: Placing dynamic inline text in flex rows without fixed slot widths or tabular numbers; displaying cumulative total tokens instead of step context delta.
- Use next time: Row metrics must be tabular: dedicated fixed-width slots (`w-[4.25rem]`, `w-[3.25rem]`), `tabular-nums`, and left-aligned starts from invisible vertical lines separated by a static `·`. Display net context delta between consecutive steps ($T_i - T_{i-1}$) accompanied by a clean `SparklesIcon`, keeping total tokens in the hover title and inspector.
- Evidence: `src/ui/runtime-graph/node-row-metrics.tsx`, `src/ui/runtime-graph/token-icon.tsx`, `src/ui/runtime-graph/tree-builder.ts`, `tests/ui/runtime-graph-tokens.test.ts`, Cycle 86.

## 2026-10-29 - Direct Generation Output Tokens and Left-Icon Alignment (Cycle 87)
- Context: Step token metrics presentation on `pi.generation` tasks.
- Symptom: Task #785 showed `+0` in the row despite details displaying `320 out`, because prompt caching caused cross-task `total - prev` to equal zero. Suffix icons and `+` signs also caused horizontal wobbling.
- Cause: Relying on cross-task cumulative context differences instead of the task's own generation output (`tokens.output`); putting the icon after digits with a leading `+` sign.
- Use next time: For generation tasks, step token metrics must prioritize `tokens.output` directly, so the row number matches the `... out` metric in the inspector. In the row slot, place the `SparklesIcon` on the left in a muted color (`text-muted-foreground/60`) followed by the unsigned number (`✨ 320`) so every token row starts from the exact same vertical line without sign jitter.
- Evidence: `src/ui/runtime-graph/token-format.ts`, `src/ui/runtime-graph/node-row-metrics.tsx`, `src/ui/runtime-graph/node-row.tsx`, `tests/ui/runtime-graph-tokens.test.ts`, Cycle 87.

## 2026-10-29 - Active Step Tokens Sum Invariant (Cycle 88)
- Context: Metric computation for generation tasks with prompt caching.
- Symptom: Displaying only `output` tokens (e.g. 85) on a turn that received 2,891 input tokens created confusion and falsely hid 97% of the turn's active context work.
- Cause: Treating generation step tokens as output-only instead of the full active work performed on that step.
- Use next time: Step token metrics must equal the honest active sum of uncached tokens for that turn: `(input ?? 0) + (output ?? 0) + (reasoning ?? 0)`. When prompt caching is active, this equals `total - cacheRead`. Provide the exact breakdown in the hover tooltip (`N step tokens (X in · Y out · Z reasoning) · T total`) and in the details inspector.
- Evidence: `src/ui/runtime-graph/token-format.ts`, `src/ui/runtime-graph/node-row.tsx`, `tests/ui/runtime-graph-tokens.test.ts`, Cycle 88.

## 2026-10-29 - Ban on Fallback Extraction and Asynchronous Entry Backfill (Cycle 89)
- Context: Resolving terminal task receipts and assistant entries in `extractTerminalTokens`.
- Symptom: In long threads with tool calls, pairs of consecutive tasks showed identical tokens ("токен в токен", e.g. #9148 and #9153 both showed 350,834 total).
- Cause: `extractTerminalTokens` contained a forbidden fallback loop that took the last assistant entry when `outcome.result.entryId` was missing from the lagging conversation view, causing newer tasks to steal previous tasks' tokens.
- Use next time: Strictly ban silent fallbacks (AP-026). If `entryId` is not found, return `undefined` honestly. In commit subscribers, capture `{ type: "entry", value: record }` into a bounded `recentEntries` cache to resolve entries synchronously with task completion, and backfill receipts via `backfillTokensFromEntries` when the view snapshot catches up.
- Evidence: `src/runner/task-tokens.ts`, `src/runner/runtime-graph-source.ts`, `src/runner/runtime-graph-receipts.ts`, `tests/ui/runtime-graph-tokens.test.ts`, Cycle 89.

## 2026-10-29 - Fluid Flexbox Labels vs. Artificial Fixed Max-Width Ceilings (Cycle 92)
- Context: Rendering task labels and file paths in `RuntimeGraphNodeRow`.
- Symptom: Long paths and commands were abruptly truncated with ellipsis (e.g. `read: /Users/vanya/Projects/pi-work...`), leaving 300-500px of empty space before the right-aligned duration metrics.
- Cause: Legacy hardcoded pixel widths (`max-w-[170px]` on breadcrumb child and `max-w-[220px]` on leaf rows) from early prototype layouts were never replaced with responsive flexbox styling.
- Use next time: Never put hardcoded pixel ceilings (`max-w-[Npx]`) on text elements inside flex containers that have right-aligned metrics (`ml-auto`). Use `truncate min-w-0` so the label fluidly expands across the entire card width, truncating with ellipsis only when the viewport or parent panel actually runs out of space.
- Evidence: `src/ui/runtime-graph/node-row.tsx`, `tests/ui/runtime-graph-responsive-width.test.ts`, Cycle 92.

## 2026-11-01 - Sovereign Kernel Decoupling and Pure POSIX Stdio Readiness (Cycle 99)
- Context: Decoupling the Pi Durable engine runner (`src/runner`) from the Beyond Boundaries host harness (`src/host`).
- Symptom: Headless consumers connecting over standard POSIX stdin/stdout hung indefinitely waiting for readiness, received `ENXIO` errors on FD 3, and host adapters performed raw SQL queries on `session.sqlite` via `DatabaseSync`.
- Cause: Readiness signal was emitted exclusively to FD 3 (`writeSync(3)`), and host adapter directly inspected the runner's internal SQLite database rather than maintaining an isolated sidecar manifest.
- Use next time: All computing kernels must support POSIX stdio as first-class citizen. Readiness must be emitted to `stdout` (`{"type":"ready",...}`), and file descriptor operations (FD 3/4) must fail quietly without throwing `ENXIO`/`EBADF`. The host adapter must never execute raw SQL against the engine's internal database; client thread mappings belong in a host-owned sidecar (`adapter-bindings.json`) synchronized via RPC.
- Evidence: `src/runner/stdout-guard.ts`, `src/runner/bridge-channel.ts`, `src/host/durable-binding-store.ts`, `tests/posix-stdio-transport.test.ts`, `tests/storage-sovereignty.test.ts`, Cycle 99.

## 2026-11-01 - Elimination of Host UI Schemas and Database Constraints from Engine Kernel (Cycle 99)
- Context: Wire lifecycle contracts and subagent task naming in `src/runner/`.
- Symptom: Wire protocol carried `planStepSchema` and `tasks_snapshot` which were discontinued in the host, and subagent records in `SubagentsDoc` artificially truncated task titles with `nativeChildTitle` to fit Beyond Boundaries Core's 500-character SQLite column limit.
- Cause: Presentation concerns from BB Inline UI and Core database schema leaked across architectural boundaries into domain entities and wire contracts.
- Use next time: Domain models must never truncate data to accommodate client UI or host DB constraints. Sanitization for client database limits (`threads.title <= 500`) belongs exclusively in the host adapter (`subthread-spawner.ts`). The domain kernel must preserve full, unclipped task strings (`task.trim()`). Presentation UI cards must never be declared as wire lifecycle events.
- Evidence: `src/contracts/wire-lifecycle.ts`, `src/runner/subagent.ts`, `src/runner/subagent-delivery.ts`, `tests/wire-contract-purity.test.ts`, Cycle 99.

## 2026-11-01 - Layer Boundary Firewall and Infallible Import Isolation (Cycle 100)
- Context: Strict decoupling of Host (`src/host`), Kernel (`src/runner`), Domain (`src/runtime-graph`), and Contracts (`src/contracts`, `src/shared`).
- Symptom: Host adapters imported private runner files (`runtime-graph-scope.ts`, `errors.ts`, `diagnostics.ts`), and `DurableEngine` leaked low-level FSM internals via `public readonly instance`.
- Cause: In the absence of an automated boundary linter, developers and agents routinely took cross-layer shortcut imports during rapid iteration.
- Use next time: Never rely on informal checklists for architectural boundaries. Always enforce layer isolation via an automated script (`scripts/verify-layer-boundaries.mjs`) hooked directly into `npm test`. Any import from `runner` in `host` or vice versa must instantly fail CI. Shared utilities belong in `src/shared/`, pure schemas in `src/contracts/`, and domain logic in domain directories.
- Evidence: `scripts/verify-layer-boundaries.mjs`, `tests/layer-boundary-firewall.test.ts`, `src/shared/errors.ts`, `src/shared/extension-runner.ts`, Cycle 100.

## 2026-11-01 - Subagent Lifecycle Invariants: Delivery Deadlock and Zombie Abort (Cycle 100)
- Context: Background subagent courier delivery and abortion handling in `src/runner/subagent-courier.ts` and `runtime-controller.ts`.
- Symptom: Subagent reports permanently stopped delivering when parent turn was busy or interrupted (`deliveryHold` deadlock), and aborted runs left background subagents alive in the OS, burning API quotas indefinitely.
- Cause: `deliveryHold` had no reset mechanism or timeout in the courier task, and `controller.abort()` called `current.abort()` without `{ background: true }` and without cascading to child conversations in `SubagentsDoc`.
- Use next time: Any hold or throttling state in an asynchronous event pipeline must have an automatic timeout watchdog and an explicit clear hook. Every cancellation command on a hierarchical agent must pass `{ background: true }` and cascade down the active conversation tree to guarantee zero orphan zombie processes.
- Evidence: `src/runner/subagent-courier.ts`, `src/runner/runtime-controller.ts`, `tests/subagent-courier-lifecycle.test.ts`, `tests/subagent-cascading-abort.test.ts`, Cycle 100.

## 2026-11-01 - SQLite WAL Database Forking: Atomic Snapshot vs Raw File Copies (Cycle 100)
- Context: Session database forking in `src/host/thread-fork.ts`.
- Symptom: Forking an active session with WAL mode produced torn pages (`SQLITE_CORRUPT`) or lock conflicts due to raw `copyFileSync` of `session.sqlite-shm` and `session.sqlite-wal`.
- Cause: Raw filesystem copying is non-atomic and copying `.sqlite-shm` between instances violates the SQLite specification.
- Use next time: Never copy active SQLite WAL or SHM files using filesystem commands. Always use SQLite's native `PRAGMA wal_checkpoint(TRUNCATE)` followed by `VACUUM INTO 'target.sqlite'`, producing an atomic, clean, single-file database snapshot with zero lock contention.
- Evidence: `src/host/thread-fork.ts`, `tests/thread-fork-wal-integrity.test.ts`, Cycle 100.

## 2026-11-01 - Test Execution Discipline: Bounded Timeouts and Child Process Cleanup (Cycle 100)
- Context: Unit and integration testing of async processes, daemons, and bash commands.
- Symptom: A test or tool execution hangs indefinitely for 15+ minutes when an unhandled event loop timer or unclosed stdio stream keeps Node.js alive.
- Cause: Tests and bash commands launched without explicit timeouts, and spawned test processes left timers active without `unref()`.
- Use next time: Every single test must specify a strict timeout (e.g. `{ timeout: 3000 }` in `node:test`). Every bash tool call must include `timeout: 30` or `timeout: 60`. In tests that spawn processes, always `unref()` timers, close stdio, and call `child.kill('SIGKILL')` in `finally` blocks to guarantee immediate exit upon completion or failure.
- Evidence: `tests/runner-command-queue.test.ts`, `tests/session-storage-pid-safety.test.ts`, Cycle 100.

## 2026-11-01 - Canonical Model Reference Normalization Across Layer Boundaries (Cycle 101)
- Context: Passing and resolving model references across Runner (`pi-ai`, `pi-durable`), Host (Beyond Boundaries), and CLI arguments.
- Symptom: Subagents deterministically crashed on launch in `inherit` mode with `SubagentPolicyInvalidError`, in `configured` mode with `SubagentModelUnavailableError`, and spawned child threads failed with `--model antigravity/antigravity/...`.
- Cause: Model references existed in multiple incompatible shapes (`{ provider, id }`, `{ provider, modelId }`, `provider/modelId`), and string concatenations naively prepended `${provider}/` to IDs that already included the provider.
- Use next time: Never format or compare model references via raw string operations or layer-specific properties. All model references must pass through a pure domain normalizer (`src/shared/model-ref.ts`) that extracts clean `provider` and `modelId` (stripping redundant provider prefixes) and produces canonical CLI strings via `formatModelCliArg`.
- Evidence: `src/shared/model-ref.ts`, `src/policy/resolver.ts`, `src/host/subthread-spawner.ts`, `tests/model-ref-normalization.test.ts`, Cycle 101.

## 2026-11-01 - Concurrency Locks: Fail-Closed Protection Over Destructive Process Killing (Cycle 101)
- Context: Lockfile contention and session ownership in `src/runner/session-storage.ts`.
- Symptom: When a subthread or concurrent command erroneously opened the same session directory, it sent `SIGTERM` to the holding PID, killing the live parent agent process.
- Cause: Legacy lock takeover logic assumed any holding process on a busy lockfile was an orphan and aggressively terminated it.
- Use next time: Never send `SIGTERM` or `SIGKILL` to another verified live process from application lock handling. Live process contention must fail closed (`SESSION_ALREADY_OPEN`) with clear diagnostic information, allowing the host or user to manage session lifetimes cleanly. Force-unlocking is strictly reserved for dead processes (`!isProcessAlive(pid)`).
- Evidence: `src/runner/session-storage.ts`, `tests/session-storage-pid-safety.test.ts`, Cycle 101.

## 2026-11-01 - Submission Retries and Cache Invalidation in Pi Durable Courier (Cycle 101)
- Context: Delivering batched subagent reports from outbox to parent conversation in `src/runner/subagent-courier.ts`.
- Symptom: If parent conversation was busy or interrupted, the courier entered a permanent 5-second infinite loop without ever delivering reports.
- Cause: Pi Durable caches submissions by `requestId`. Re-submitting with the identical `requestId` returned the cached terminal `unanswered` submission immediately, re-triggering `deliveryHold` indefinitely.
- Use next time: Whenever retrying a submission or command through an idempotency-protecting substrate, retry attempts must rotate the `requestId` suffix (e.g. `...:r1`, `...:r2`) so the underlying engine treats it as a fresh attempt while preserving batch identity.
- Evidence: `src/runner/subagent-courier.ts`, `src/runner/subagent-docs.ts`, `tests/subagent-courier-lifecycle.test.ts`, Cycle 101.

## 2026-11-02 - WASM Asset Retention and Direct Dependency Anchoring in Plugin Environments (Cycle 102)
- Context: Loading QuickJS WebAssembly module in `@earendil-works/pi-codemode` via `quickjs-wasi/quickjs.wasm`.
- Symptom: In long-running host processes, after a plugin update, calling `codemode` crashed with `MODULE_NOT_FOUND: Cannot find module 'quickjs-wasi/quickjs.wasm'`.
- Cause: Beyond Boundaries installs plugins into git commit hash directories (`~/.bb/plugins/cache/git/.../<commit-hash>`). When BB updates a plugin or restarts, it cleans up old commit folders. If `quickjs-wasi` was resolved dynamically from disk without being anchored in direct `dependencies` and copied into `dist/`, the runtime lost the `.wasm` file path while the process was still alive.
- Use next time: Any package requiring native binary or WebAssembly assets must be declared in direct `dependencies` in `package.json`, and the build pipeline (`scripts/build-runner.mjs`) must explicitly copy `.wasm` files directly into `dist/` so that runtime resolution does not depend on ephemeral cache directories.
- Evidence: `scripts/build-runner.mjs`, `package.json`, `dist/runner/quickjs.wasm`, Cycle 102.

## 2026-11-02 - StructuredOutput Enforcement on Tools with outputSchema in Pi Durable (Cycle 102)
- Context: Executing MCP and extension tools through `codemode` and tool adapters in `src/runner/tool-adapter.ts` and `src/runner/extension-mount.ts`.
- Symptom: Invoking an MCP tool from a JavaScript snippet in QuickJS failed with `Error: Tool <name> returned no structuredOutput`, marking the tool call as `isError: true` despite successful execution.
- Cause: In `@earendil-works/pi-durable`, when a tool registers `outputSchema` (or `structuredOutputSchema`), the engine validates `outcome.result.structuredOutput`. The custom adapter was stripping `result.structuredContent` and returning only textual `output: result.content`. Because `structuredOutput` was missing, Durable's `structuredOutputError()` guard rejected the call.
- Use next time: Whenever adapting tools that can declare structured schemas, adapters must always preserve and forward both `output` (text blocks) AND `structuredOutput` (`structuredContent ?? structuredOutput`). Nested tool execution contexts must also surface `structuredOutput` to callers.
- Evidence: `src/runner/tool-adapter.ts`, `src/runner/extension-mount.ts`, `tests/codemode-structured-output.test.ts`, `scripts/diagnose-codemode.ts`, Cycle 102.

## 2026-11-02 - Complete Lifecycle Teardown for Sandboxes and Worker Threads (Cycle 102)
- Context: Session termination and cleanup in `src/runner/runtime-loader.ts` and `src/runner/plugins/built-in/codemode.ts`.
- Symptom: Node.js worker threads and WebAssembly instances were leaked between restarts, degrading host daemon performance.
- Cause: `createCodingRegistry` instantiated `DurablePluginRegistry` locally and discarded it. Plugins that allocated resources (such as `CodemodeSandbox`) never had their `teardown()` methods called because the registry was unlinked from session `cleanup()`.
- Use next time: The Composition Root must maintain and return references to all registries holding stateful resources. Session `cleanup()` must invoke `pluginRegistry.teardownAll()`, and plugins must implement `teardown()` to terminate worker threads (`sandbox.close()`) and clear transient holds.
- Evidence: `src/runner/plugins/built-in/codemode.ts`, `src/runner/harness-setup.ts`, `src/runner/runtime-loader.ts`, `tests/codemode-plugin-lifecycle.test.ts`, Cycle 102.








