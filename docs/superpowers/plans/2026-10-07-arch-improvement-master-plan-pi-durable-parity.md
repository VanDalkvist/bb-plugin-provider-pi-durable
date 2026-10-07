# Master Architectural Implementation Plan: Remediation & Full Parity of Pi Durable in BB IDE

**Document ID:** `plans/pi-durable-bb-provider-arch-master-plan`  
**Version:** 3.4.0 (Master Unified Roadmap: Remediation + Feature Parity)  
**Target Repository:** `/Users/vanya/Projects/bb-plugin-provider-pi-durable`  
**Governing Standard:** `arch-rules.md` (AP-010 – AP-071) & `arch-improvement-loop` State Machine  
**Upstream PRDs:**
- `prd/pi-durable-provider-remediation` (Audit of 13 Critical Divergences in Implemented Features)
- `prd/pi-durable-bb-provider-full-parity` (Complete Engine Capabilities & Parity Features)  
**Execution Model:** 13 Distinct Sequential Arch Improvement Loop Cycles (Cycle 56 to Cycle 68), each executed in a dedicated thread with strict verification gates.

---

## 1. Architectural Guardrails & Invariants (AP Rules)

Every cycle must strictly comply with the baseline and critical architectural rules:
1. **AP-010 (Modular Monolith & Ports/Adapters):** Clean separation between Host Bridge (Interface), Session Management (Application), and Runner Process (Infrastructure Port).
2. **AP-012 (Fail-Fast & Explicit Contracts):** No loose type fallbacks. Tool failures or invalid states must fail immediately with typed errors.
3. **AP-013 (Data Integrity without Fakes):** Strictly prohibited to forge fake completions, fake fork sessions, fake token sums, or fake tool results. Every state must originate from SQLite / Chord transactions.
4. **AP-019 (File Size Limits & Modularity):**
   - **Soft limit:** 150 lines per file.
   - **Hard limit:** 250 lines per file. Any file approaching 250 lines MUST be modularized into cohesive domain files before merge.
   - Functions < 40 lines, cyclomatic complexity <= 10.
   - 1 file = 1 responsibility + 1 primary export. No catch-all `utils.ts` or `helpers.ts`.
5. **AP-020 (Clean Architecture & Composition Root):** Wiring happens strictly in `src/host/index.ts` and `src/runner/index.ts`. No cross-boundary leaky imports.
6. **AP-021 (Thin Entry Points):** All JSON-RPC and CLI command handlers only validate input, call the application use-case, and map results to DTOs.
7. **AP-022 (Typed Errors & Explicit Exception Handling):**
   - **Zero empty catch blocks.**
   - All errors wrapped into typed errors or logged with structured context.
   - Intentional ignores must have `// intentionally ignored: <reason>`.
8. **AP-023 (Async Discipline & No Floating Promises):** Every Promise must be `await`ed or explicitly tracked. `void` permitted only for deliberate, monitored fire-and-forget.
9. **AP-026 (API Contracts & DTO Boundaries):** Strict DTO interfaces and Zod schemas for all inter-process IPC messages.
10. **AP-028 (Testing Strategy & Determinism):** Every behavioral fix must follow TDD (Red -> Green -> Refactor) with deterministic assertions.
11. **AP-029 (TypeScript Strictness & Node 26 Strip Mode):**
    - Zero `any` (or strictly bounded).
    - **No constructor parameter properties** (`constructor(private foo: ...)` is forbidden; use explicit class field definitions).
12. **AP-033 / AP-034 (Database Atomicity & Concurrency):** All session writes must pass through ACID SQLite/Chord transactions with stale lock protection (10s expiry).

---

## 2. Standard Arch Loop Cycle State Machine

Every individual cycle (Cycles 56 through 67) must be executed in its own dedicated thread, strictly walking the 13 states:

```
[S0 Bootstrap] -> [S1 Memory Load] -> [S2 Orientation] -> [S3 Brainstorm Gate]
      |
      v
[S4 Review & Findings] -> [S5 Triage Gate] -> [S6 Plan Write] -> [S7 Plan Review]
      |
      v
[S8 Execute Fix Slice (TDD)] -> [S9 Verify Gate] -> [S10 Ledger Update]
      |
      v
[S11 Learn Gate] -> [S12 Terminal Stop]
```

---

## 3. Two-Stage Master Roadmap Overview

```
STAGE 1: FOUNDATION HARDENING & AUDIT REMEDIATION (Cycles 56–60)
Eliminate all 13 divergences and community bugs in session, streaming, tool, context, and model code.
  - Cycle 56: Process Lifecycle, Lock Cleanup, Error Diagnostics & Session Path Normalization (D-1, D-2, D-13, Issues #1, #2, #3) [COMPLETED - v0.2.1]
  - Cycle 57: Context Window Telemetry & Usage Synchronization (Issue #4) [COMPLETED - v0.2.2]
  - Cycle 58: Tool Execution Telemetry & Steer Protocol Integrity (Issues #5, #6) [COMPLETED - v0.2.3]
  - Cycle 59: Tool Fault Integrity, Diff Metadata & Thinking Accordion Lifecycle (D-4, D-5, D-6, D-9, D-12)
  - Cycle 60: Full Native Event Streaming, Checkpoints & Model Compatibility (D-3, D-7, D-8, D-10, D-11)

STAGE 2: ADVANCED ENGINE CAPABILITIES & FULL PARITY (Cycles 61–68)
Build new advanced capabilities on top of the hardened, defect-free foundation.
  - Cycle 61: Checkpoint Thread Forking, Session Rewind & Message Editing (`thread/fork` & `bb thread edit-message`)
  - Cycle 62: Provider Usage & Granular Spend Ledger (`provider/usage`)
  - Cycle 63: Visual Subagent Delegation Cards & Hierarchy (`type: "delegation"`)
  - Cycle 64: Live Task Graph Synchronization (`harness.taskGraph()`)
  - Cycle 65: Advanced Inbox Queuing & Cancellation (`submission.abort` & `write`)
  - Cycle 66: Context Handoff Reset (`/reset`) & Compaction Policies
  - Cycle 67: Tool Replay Safety & Dynamic Runtime Expansion (`replay` & `control`)
  - Cycle 68: Custom Durable Chord Documents (`defineDoc`) & Master Conformance
```

---

## 4. Dedicated Cycle Specifications

---

### STAGE 1: FOUNDATION HARDENING (Cycles 56–59)

---

### Cycle 56: Process Lifecycle, Lock Cleanup, Error Diagnostics & Session Path Normalization [COMPLETED]
- **Status:** ✅ COMPLETED (Commits: `f4b685e`, `969b180`; Release: `v0.2.1`)
- **PRD Divergences & Community Defects Covered:** D-1, D-2, D-13 (FR-18, FR-R1, FR-R2, FR-R12, UJ-9) + GitHub Issues #1 (CWD Hijacking), #2 (Runner Discovery in host-cache), #3 (Premature Readiness & Swallowed Startup Errors).
- **Architectural Implementation Summary:**
  1. **Multi-Tier Runner Discovery (`src/host/paths.ts`):** 6-tier discovery (env overrides -> direct relative paths -> `node:sqlite` lookup of `root_dir` from `~/.bb/bb.db` -> git/npm cache recursive search -> plugin directories -> sibling directories).
  2. **CWD Isolation & Strict Parsing (`src/runner/cli-args.ts`, `src/host/session.ts`):** Removed `--session-dir` parameter; hardened `parseCliArgs` to support `--cwd <val>` and non-greedy boolean flags without consuming positional workspace paths.
  3. **Atomic Fail-Fast Readiness (`src/runner/index.ts`, `src/host/session.ts`, `src/host/catalog.ts`):** Runner readiness announced strictly after `openDurable()` and event stream binding in active sessions; errors/timeouts in `start()` reject immediately and trigger `this.kill()` without zombie processes; timeouts cleared in `finally`.
  4. **Graceful Lock Release (D-1):** In `src/runner/index.ts`, `SIGTERM`/`SIGINT`/`stdin.end` await `activeDurable.close()` before exit, releasing `proper-lockfile` cleanly without 10-second delay on restart.
  5. **Session Path Normalization (D-2):** Removed `.jsonl` suffixes from SQLite session directories in `paths.ts` and `sessions.ts`.
  6. **Modularization (AP-019):** Decomposed `src/runner/runtime.ts` (430 lines) into `runtime-types.ts` (104), `runtime-controller.ts` (147), `runtime-loader.ts` (111), and `runtime.ts` facade (213). All files in project <= 224 lines (< 250 lines hard limit).
- **Verification Evidence:**
  - `npm test`: 34 / 34 passing assertions (0 failed, 0 skipped).
  - `npm run build`: cleanly builds `dist/runner/index.js`, `dist/host.js`, `dist/server.js`.
  - Independent architectural review: confirmed PASS.
- **Architectural Problem:**
  1. `SIGTERM`, `SIGINT`, `stdin.on("end")` call `process.exit(0)` immediately without awaiting `durable.close()`. This leaves `proper-lockfile` unreleased, forcing thread resume or start to freeze for 10 seconds waiting for stale lock timeout (D-1).
  2. `paths.ts` appends `.jsonl` to session path (`thr_xxx.jsonl`), causing SQLite sessions to live in directories named `thr_xxx.jsonl/session.sqlite` (D-2).
  3. Systemic errors (invalid `cwd`, unmounted volumes, runner spawn failures, unexpected runner exits) are swallowed or sent only as raw JSON-RPC `-32000` responses without emitting `provider.error` deltas into the thread. In the BB IDE UI, the user sees complete silence: no error card, and the input hangs indefinitely (D-13).
- **Target Solution:**
  1. **Graceful Shutdown & Lock Release:** In `src/runner/index.ts`, hook termination signals to execute `await durable.close()` before exit, releasing `proper-lockfile` instantly.
  2. **Location Validation:** In `src/host/session.ts` and `src/host/bridge.ts`, validate `cwd` existence and directory status before launch (`statSync.isDirectory()`). If invalid, emit `provider.error` delta with detailed path and `settlesTurn: true`.
  3. **Process Observability:** In `src/host/runner-process.ts`, bind `child.on("error")`, capture `stderrTail`, and invoke `onExit` callback on `PiThreadSession`.
  4. **Diagnostic Delta Forwarding:** In `src/host/session.ts` and `src/host/bridge.ts`, handle unexpected exits and startup failures by emitting `{ kind: "provider.error", message, detail, settlesTurn: true }` and JSON-RPC `error` notification.
  5. **Session Path Normalization:** Standardize session paths in `paths.ts` to `~/.bb/pi-bridge-sessions/<sanitizedThreadId>/session.sqlite`.
- **File Impact & Line Budget (AP-019):**
  - `src/runner/index.ts`: +20 lines (~180 lines).
  - `src/host/paths.ts`: +15 lines (~75 lines).
  - `src/host/runner-process.ts`: +30 lines (~155 lines).
  - `src/host/session.ts`: +35 lines (~185 lines).
  - `src/host/bridge.ts`: +25 lines (~215 lines).
  - `tests/lifecycle-and-error-diagnostics.test.ts`: new file (~140 lines).
- **Test Suite (TDD):**
  - Verify `SIGTERM` immediately releases `proper-lockfile` (< 100 ms re-acquisition).
  - Verify launching with invalid `cwd` emits `provider.error` delta with readable diagnostic and `settlesTurn: true`.
  - Verify runner child crash mid-turn emits `provider.error` and marks turn failed without input hang.
- **Verification Gates:**
  - `npm test` passes.
  - Live BB test: Running against non-existent directory immediately displays a red error card in BB IDE chat instead of silence.

---

### Cycle 57: Context Window Telemetry & Usage Synchronization [COMPLETED]
- **Status:** ✅ COMPLETED (Release: `v0.2.2`)
- **Issues Covered:** Issue #4 (`usedTokens: 0` in context bar, missing contextWindow propagation, agentDoc fallback, legacy directory migration).
- **Architectural Implementation Summary:**
  1. **IPC Response Unwrapping (`src/host/runner-process.ts`, `src/host/session.ts`):** Fixed `RunnerProcess.requestOk` to unwrap nested `{ data: { contextUsage } }` payload; updated `getSessionStats()` to defensively unwrap stats.
  2. **Turn Boundary Ordering (`src/host/session.ts`):** Guaranteed `await refreshContextUsage()` executes *before* emitting `turn.boundary` on `agent_end` so usage attaches to the active turn.
  3. **Model Fallback Resolution (`src/runner/session-commands.ts`):** Added fallback to `args.provider` and `args.model` when `agentDoc.model` is unpopulated on thread initialization.
  4. **Adapter Wire Propagation (`src/runner/bridge/bb-event-adapter.ts`, `src/host/delta-translator.ts`):** Passed `resolveContextWindow` into `BBEventAdapter`, included `contextWindow` on `turn_end` and `agent_end`, and mapped into `usage` deltas.
  5. **Legacy Directory Adoption (`src/runner/sessions.ts`):** Added fallback migration for legacy directory names (`${sanitized}.jsonl/session.sqlite`).
- **Verification Evidence:**
  - `npm test`: 40 / 40 passing assertions.
  - Live BB verification: Context ring indicator and bar display accurate token usage.

---

### Cycle 58: Tool Execution Telemetry & Steer Protocol Integrity [COMPLETED]
- **Status:** ✅ COMPLETED (Commit: `eae5c31`, Release: `v0.2.3`)
- **Issues Covered:**
  - Issue #6: `edit` and `write` tool calls completely invisible in BB chat due to invalid `fileChange` schema values (`kind: "create"` / `"modify"` instead of `"add"` / `"update"`).
  - Issue #5: Steer messages stuck in "Steer pending" / "Working..." due to `providerTurnId: params.expectedTurnId` causing 409 `MissingStoredTurnStartedError`.
- **Architectural Implementation Summary:**
  1. **Schema Compliance & Edits Mapping (`src/host/tool-delta-translator.ts`):**
     - Mapped `write` to schema-compliant `kind: "add"` with `newText: args.content`.
     - Mapped `edit` to schema-compliant `kind: "update"`. Mapped `args.edits` array to granular update items with `oldText` and `newText`.
     - Output deltas now strictly pass BB host-daemon Zod validation (`jCe`), restoring full visibility of file change tool cards in the chat UI.
  2. **Steer Protocol Acceptance (`src/host/bridge.ts`):**
     - Omitted `providerTurnId` from `input.accepted` delta in `turn/steer`.
     - Allows host-daemon assembler to associate steer input directly with the active turn, eliminating 409 conflict and permanent UI freeze.
  3. **Thread State Reconciliation:**
     - Reconciled stuck legacy threads (including `thr_ixcw5bus8c`), transitioning status to `idle` and refreshing the context meter to `125,390 / 1,048,576 tokens`.
- **Verification Evidence:**
  - `npm test`: 43 / 43 passing assertions across 5 suites.
  - Build clean: `dist/runner/index.js`, `dist/host.js`, `dist/server.js`.
  - Issue #5 and #6 verified fixed.

---

### Cycle 59: Tool Fault Integrity, Diff Metadata & Thinking Accordion Lifecycle
- **PRD Divergences Covered:** D-4, D-5, D-6, D-9, D-12 (FR-R4, FR-R5, FR-R6, FR-R7, FR-R11).
- **Architectural Problem:**
  1. When a tool task crashes or is orphaned, `event.entry` is `undefined`. `bb-event-adapter.ts` evaluates `entry?.model?.[0]?.isError ?? false`, erroneously reporting fatal tool crashes as successful completions with empty output (violating AP-012/AP-013) (D-5).
  2. `CodingTools.edit` returns `details: { diff, patch, firstChangedLine }`, but `bb-event-adapter.ts` drops `event.details`, depriving BB Diff Viewer of patch data (D-6).
  3. `tool_execution_update` ignores `trimStart` and drops `ToolDiagnostic` warnings (D-9).
  4. Model thinking/reasoning lifecycle is incomplete:
     - `catalog.ts` ignores `m.reasoning` and `m.thinkingLevelMap`.
     - `turn/start` does not dynamically apply `reasoningLevel` via `set_thinking_level`.
     - `bb-event-adapter.ts` hardcodes `contentIndex: 0`, drops `thinking_start` and `block`, and never emits `thinking_end` (D-4).
     - `delta-translator.ts` streams `reasoningText` but never sends `item.textClose`, preventing BB from closing the item into the `Thought for Xs` accordion (D-12).
- **Target Solution:**
  1. In `bb-event-adapter.ts`, if `event.entry === undefined` in `tool_execution_end`, enforce `isError: true` and `result: "Tool execution faulted or was orphaned"`.
  2. Forward `details` (patch, diff, line) into `tool_execution_end` and `tool-delta-translator.ts`.
  3. Support `output.trimStart` and forward diagnostics.
  4. Preserve real `change.contentIndex`, stream `item.textDelta` on `channel: "reasoningText"`, and finalize with `item.textClose` for collapsible thinking accordion.
- **File Impact & Line Budget (AP-019):**
  - `src/runner/bridge/bb-event-adapter.ts`: +35 lines (~185 lines).
  - `src/host/tool-delta-translator.ts`: +25 lines (~145 lines).
  - `src/host/delta-translator.ts`: +30 lines (~235 lines).
  - `tests/tool-fault-and-thinking.test.ts`: new file (~130 lines).
- **Verification Gates:**
  - `npm test` passes.
  - Diff viewer renders syntax-highlighted patches and reasoning model displays `Thought for Xs` accordion.

---

### Cycle 60: Full Native Event Streaming, Checkpoints & Model Compatibility
- **PRD Divergences Covered:** D-3, D-7, D-8, D-10, D-11 (FR-R3, FR-R8, FR-R9, FR-R10).
- **Architectural Problem:**
  1. Dropped native events: `snapshot`, `auto_retry_start/end`, `deferred_poll`, `task_failed`, `agent_changed` (D-3, D-10).
  2. Cumulative token spend falsification: `delta-translator.ts` duplicates single-turn `last` usage into `total` usage upon `agent_end`, resetting total cost every turn (D-7).
  3. `setThinkingLevel` throws when called on non-reasoning models (`!model.reasoning`), even when setting `off`/`none` (D-8).
  4. `turn.boundary` lacks `providerCheckpointId`, causing message editing on turns $N \ge 2$ to fail with HTTP 409 (D-11).
- **Target Solution:**
  1. Map `snapshot` events to restore live in-flight slots on reconnect; translate `auto_retry` events to user progress notices.
  2. In `delta-translator.ts`, accumulate genuine monotonic `totalTokens` from `docs["pi.usage"]`.
  3. In `runtime.ts` and `catalog.ts`, guard `setThinkingLevel` so non-reasoning models safely accept `off`/`none` without error.
  4. Capture tail `EntryId` on `agent_end` and pass as `providerCheckpointId` in `turn.boundary` delta.
- **File Impact & Line Budget (AP-019):**
  - `src/host/catalog.ts`: +20 lines (~130 lines).
  - `src/runner/runtime-controller.ts`: +15 lines (~160 lines).
  - `src/runner/bridge/bb-event-adapter.ts`: +30 lines (~215 lines).
  - `src/host/delta-translator.ts`: +25 lines (~245 lines).
  - `tests/stream-parity-and-checkpoints.test.ts`: new file (~130 lines).
- **Verification Gates:**
  - `npm test` passes.
  - Monotonic token accumulation and checkpoint rewind IDs verified.

---

### STAGE 2: ADVANCED ENGINE CAPABILITIES & FULL PARITY (Cycles 61–68)

---

### Cycle 61: Checkpoint Thread Forking, Session Rewind & Message Editing (`thread/fork` & `bb thread edit-message`)
- **PRD Epics Covered:** FR-1, FR-2, FR-16, D-11, UJ-1, UJ-7, JTBD-2, JTBD-6.
- **Architectural Problem:**
  1. `thread/fork` in `bridge.ts` ignores `sourceProviderThreadId` and `sourceProviderCheckpointId`, falling back to creating an unbranched fresh session.
  2. When a user runs `bb thread edit-message` or clicks "Edit" in BB UI on turn $N \ge 2$, BB issues `thread.rewind.prepare`, calling `thread/fork` with `sourceProviderCheckpointId`. Without branch staging and history rewind, message editing fails with HTTP 409 or loses prior context.
- **Target Solution:**
  1. Add IPC command `fork` to runner accepting `{ sourceProviderThreadId, checkpointId, targetThreadId, cwd }`.
  2. In `src/runner/fork.ts`, execute `@earendil-works/pi-durable`'s `conversation.fork(checkpointEntryId, { ownership: { kind: "ownerless" } })`, preserving all document states `asOf` that checkpoint commit and minting a fresh provider UUIDv7 `sessionId`.
  3. Support branching across SQLite database directories: clone/fork database into `~/.bb/pi-bridge-sessions/<targetThreadId>/session.sqlite`.
  4. In `src/host/bridge.ts`, handle `thread/fork`:
     - If `params.threadId` contains `:rewind:`, register staged rewind session for the lease.
     - On subsequent `thread.start` with `fork: { sourceProviderThreadId: stagedProviderThreadId }`, adopt the staged session and bind the new prompt.
  5. Ensure non-destructive file retention: all disk modifications in workspace remain intact during history rewinds.
- **File Impact & Line Budget (AP-019):**
  - `src/runner/fork.ts`: new file (~120 lines).
  - `src/runner/index.ts`: wire command (~25 lines).
  - `src/host/bridge.ts`: +25 lines.
  - `src/host/session.ts`: +30 lines.
- **Test Suite (TDD):**
  - `tests/thread-fork-and-rewind.test.ts`: test fork at checkpoint of multi-turn session; test `thread.rewind.prepare` lifecycle and assert child session contains exact documents up to checkpoint; test simulated `bb thread edit-message` handshake.
- **Verification Gates:**
  - `npm test` passes.
  - Live BB CLI check: `bb thread fork <thread-id>` branches cleanly.
  - Live BB CLI check: `bb thread edit-message <thread-id> --message "..."` rewinds history to preceding checkpoint and reruns cleanly while keeping workspace changes.

---

### Cycle 62: Provider Usage & Granular Spend Ledger (`provider/usage`)
- **PRD Epics Covered:** FR-11, UJ-6, JTBD-5.
- **Target Solution:**
  1. Add IPC command `get_usage` to runner.
  2. In runner, query `durable.harness.usage(context)` and read `docs["pi.usage"]`.
  3. Extract structured spending: `totalTokens`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalCost`, `byModel`, `byTool`.
  4. In host, implement `src/host/usage.ts` (< 120 lines) to translate Pi usage into standard BB `provider/usage` DTO.
  5. In `src/host/bridge.ts`, wire `case "provider/usage"` to `Session.getUsage()`.
- **File Impact & Line Budget (AP-019):**
  - `src/host/usage.ts`: new file (~90 lines).
  - `src/host/bridge.ts`: +10 lines.
  - `src/runner/index.ts`: +20 lines.
- **Test Suite (TDD):**
  - `tests/provider-usage.test.ts`: verify `getUsage` returns expected token breakdown and tool call tallies matching `docs["pi.usage"]`.
- **Verification Gates:**
  - `npm test` passes.
  - Thread Usage panel in BB IDE renders live metrics.

---

### Cycle 63: Visual Subagent Delegation Cards & Hierarchy (`type: "delegation"`)
- **PRD Epics Covered:** FR-3, FR-4, UJ-2, JTBD-3.
- **Target Solution:**
  1. Update `src/runner/subagent.ts` to assign `ownership: { kind: "task", taskId }` to child conversations.
  2. In `src/runner/bridge/bb-event-adapter.ts`, intercept child conversation events and emit:
     - `item.open` with `type: "delegation"`, `providerItemId: childConversationId`, `subagentName`, `description`.
     - Child reasoning (`reasoningText`) and child tools nested under delegation card key.
     - `item.close` with status and returned answer.
  3. Update `src/host/tool-delta-translator.ts` to handle `type: "delegation"` deltas.
- **File Impact & Line Budget (AP-019):**
  - `src/runner/bridge/delegation-adapter.ts`: new file (~130 lines).
  - `src/runner/subagent.ts`: refactor to use delegation adapter (~110 lines).
  - `src/host/tool-delta-translator.ts`: +20 lines.
- **Test Suite (TDD):**
  - `tests/subagent-delegation.test.ts`: assert child conversation dispatches proper `item.open (type: "delegation")` and nests tool calls without leaking to root stream.
- **Verification Gates:**
  - Unit tests pass.
  - Visual verification in BB chat: delegation cards collapse/expand and display subagent tools.

---

### Cycle 64: Live Task Graph Synchronization (`harness.taskGraph()`)
- **PRD Epics Covered:** FR-5, UJ-5, JTBD-4.
- **Target Solution:**
  1. In runner, subscribe to `harness.taskGraph(context)`.
  2. Emit `task_graph_update` wire events whenever tasks transition (`pending`, `running`, `waiting`, `completing`, `done`, `failed`).
  3. In `src/host/delta-translator.ts`, map task transitions to BB `backgroundTask` timeline items or plan step items.
- **File Impact & Line Budget (AP-019):**
  - `src/runner/bridge/task-graph-adapter.ts`: new file (~110 lines).
  - `src/host/task-delta-translator.ts`: new file (~100 lines).
  - `src/host/delta-translator.ts`: delegate task events.
- **Test Suite (TDD):**
  - `tests/task-graph.test.ts`: test dependency graph transitions (`waiting` -> `running` -> `done`) and verify correct wire delta emissions.
- **Verification Gates:**
  - Unit tests pass.
  - Live task status rows appear in BB IDE task panel.

---

### Cycle 65: Advanced Inbox Queuing & Cancellation (`submission.abort` & `write`)
- **PRD Epics Covered:** FR-6, FR-7, FR-8, UJ-3, JTBD-4.
- **Target Solution:**
  1. Handle `turn/cancel_queued` in `src/host/bridge.ts`, delegating to `session.cancelQueued(clientRequestId)`.
  2. In runner, call `submission.abort()` on corresponding submission in `docs["pi.inbox"]`.
  3. Add `write_entry` IPC command to runner: calls `conversation.submit({ type: "write", entry })` committing an entry without spawning a LLM generation task.
  4. Support configurable `QueueMode` (`"one-at-a-time"` vs `"all"`).
- **File Impact & Line Budget (AP-019):**
  - `src/host/bridge.ts`: +15 lines.
  - `src/host/session.ts`: +25 lines.
  - `src/runner/index.ts`: +30 lines.
- **Test Suite (TDD):**
  - `tests/inbox-controls.test.ts`: test queuing an item, aborting it while busy, and verifying the LLM never executes it; test writing a passive entry and asserting no LLM call.
- **Verification Gates:**
  - Unit tests pass.
  - Clicking "Cancel" in BB chat feed immediately cancels queued instruction.

---

### Cycle 66: Context Handoff Reset (`/reset`) & Compaction Policies
- **PRD Epics Covered:** FR-9, FR-10, UJ-4, JTBD-5.
- **Target Solution:**
  1. In `src/host/prompt-input.ts`, detect `/reset [handoff note]`.
  2. In runner, invoke `conversation.reset(handoffNote, context)`.
  3. The model window resets to `[handoffNote]`, context meter drops to near-zero, while all historical entries remain in SQLite.
  4. Expose `reserveTokens`, `keepRecentTokens`, and `backgroundTokens` via session options into `HarnessSettings.compaction`.
- **File Impact & Line Budget (AP-019):**
  - `src/host/prompt-input.ts`: update command detector (~20 lines).
  - `src/runner/runtime.ts`: bind compaction settings (~25 lines).
  - `src/runner/index.ts`: wire `/reset` (~20 lines).
- **Test Suite (TDD):**
  - `tests/context-handoff.test.ts`: verify `/reset` resets active context messages while preserving full SQLite history and reducing estimated tokens.
- **Verification Gates:**
  - Unit tests pass.
  - Running `/reset Starting phase 2` in chat resets Context Meter and starts clean turn.

---

### Cycle 67: Tool Replay Safety & Dynamic Runtime Expansion (`replay` & `control`)
- **PRD Epics Covered:** FR-12, FR-13, FR-14, UJ-1, UJ-2.
- **Target Solution:**
  1. Annotate read-only tools (`read`, `image`, search tools) with `replay: "safe"`.
  2. In runner tool execution loop, support `control: { terminate: true }` (closes turn without extra model request) and `control: { addTools: [...] }` (adds dynamic tools to subsequent rounds).
  3. Translate tool diagnostics (`ToolDiagnostic`: severity, message, code) into BB diagnostic markers.
- **File Impact & Line Budget (AP-019):**
  - `src/runner/bridge/tool-control-adapter.ts`: new file (~100 lines).
  - `src/runner/index.ts`: update tool registration (~25 lines).
- **Test Suite (TDD):**
  - `tests/tool-controls.test.ts`: test safe tool replay on crash recovery; test `control.terminate` turn closure without model re-query.
- **Verification Gates:**
  - Unit tests pass.
  - Simulated crash during `read` re-executes cleanly on restart.

---

### Cycle 68: Custom Durable Chord Documents (`defineDoc`) & Master Conformance
- **PRD Epics Covered:** FR-15, NFR-1..8, All User Journeys (UJ-1 – UJ-6).
- **Target Solution:**
  1. Provide a generic `defineDoc<T>` bridge in runner, allowing plugins to commit custom documents alongside transcript entries.
  2. Implement an automated E2E conformance test suite (`tests/e2e-conformance.test.ts`) that verifies all 6 User Journeys:
     - Crash recovery (UJ-1)
     - Checkpoint fork (UJ-1)
     - Delegation hierarchy (UJ-2)
     - Steer & queue cancellation (UJ-3)
     - Handoff reset (UJ-4)
     - Task graph updates (UJ-5)
     - Usage accounting (UJ-6)
- **File Impact & Line Budget (AP-019):**
  - `src/runner/runtime.ts`: add document definition helper (~30 lines).
  - `tests/e2e-conformance.test.ts`: comprehensive integration test (~220 lines).
- **Verification Gates:**
  - All test suites pass (100% green).
  - Zero file length violations (< 250 lines across all files).
  - Zero empty catches, zero floating promises.
  - Master conformance sign-off.

---

## 5. Execution Protocol: How Each Cycle Must Be Run

Для каждого цикла с 56 по 67:
1. **Выделенный тред:** Запуск отдельного треда в BB IDE (например, `@thread:cycle-56-lifecycle-locks`).
2. **Загрузка скиллов:** `arch-improvement-loop` + правила `arch-rules.md`.
3. **Загрузка контекста (S1):** Проверка `prd/pi-durable-provider-remediation` или `prd/pi-durable-bb-provider-full-parity` через `brain-ops`.
4. **Ориентация (S2):** Аудит строк файлов: `wc -l src/host/*.ts src/runner/*.ts`.
5. **Согласование контракта (S3):** Гейт согласования сигнатур и поведения с пользователем.
6. **Написание плана (S6/S7):** Фиксация `docs/superpowers/plans/YYYY-MM-DD-arch-improvement-cycle-N.md`.
7. **TDD (S8):** Падающий тест -> минимальный фикс -> прохождение теста -> рефакторинг.
8. **Верификация (S9):** `npm test`, `npx tsc --noEmit`, `npm run build`.
9. **Леджер (S10):** Запись отчета в `.arch-improvement/review-log.md`.
10. **Память (S11):** Коммит факта в gbrain через `mcp__gbrain__remember`.
