# Master Architectural Implementation Plan: Remediation & Full Parity of Pi Durable in BB IDE

**Document ID:** `plans/pi-durable-bb-provider-arch-master-plan`  
**Version:** 3.0.0 (Master Unified Roadmap: Remediation + Feature Parity)  
**Target Repository:** `/Users/vanya/Projects/bb-plugin-provider-pi-durable`  
**Governing Standard:** `arch-rules.md` (AP-010 – AP-071) & `arch-improvement-loop` State Machine  
**Upstream PRDs:**
- `prd/pi-durable-provider-remediation` (Audit of 10 Critical Divergences in Implemented Features)
- `prd/pi-durable-bb-provider-full-parity` (Complete Engine Capabilities & Parity Features)  
**Execution Model:** 12 Distinct Sequential Arch Improvement Loop Cycles (Cycle 56 to Cycle 67), each executed in a dedicated thread with strict verification gates.

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
STAGE 1: FOUNDATION HARDENING & AUDIT REMEDIATION (Cycles 56–59)
Eliminate all 10 divergences in already-implemented session, streaming, tool, and model code.
  - Cycle 56: Process Lifecycle, Lock Cleanup & Session Path Normalization (D-1, D-2)
  - Cycle 57: Tool Fault Integrity, Error Reporting & Diff Metadata Forwarding (D-5, D-6, D-9)
  - Cycle 58: Full Native Event Streaming & Multi-Block Reasoning Channels (D-3, D-4, D-10)
  - Cycle 59: Model Reasoning Compatibility & Cumulative Usage Integrity (D-7, D-8)

STAGE 2: ADVANCED ENGINE CAPABILITIES & FULL PARITY (Cycles 60–67)
Build new advanced capabilities on top of the hardened, defect-free foundation.
  - Cycle 60: Checkpoint Thread Forking & History Branching (`thread/fork`)
  - Cycle 61: Provider Usage & Granular Spend Ledger (`provider/usage`)
  - Cycle 62: Visual Subagent Delegation Cards & Hierarchy (`type: "delegation"`)
  - Cycle 63: Live Task Graph Synchronization (`harness.taskGraph()`)
  - Cycle 64: Advanced Inbox Queuing & Cancellation (`submission.abort` & `write`)
  - Cycle 65: Context Handoff Reset (`/reset`) & Compaction Policies
  - Cycle 66: Tool Replay Safety & Dynamic Runtime Expansion (`replay` & `control`)
  - Cycle 67: Custom Durable Chord Documents (`defineDoc`) & Master Conformance
```

---

## 4. Dedicated Cycle Specifications

---

### STAGE 1: FOUNDATION HARDENING (Cycles 56–59)

---

### Cycle 56: Process Lifecycle, Lock Cleanup & Session Path Normalization
- **PRD Divergences Covered:** D-1, D-2.
- **Architectural Problem:**
  1. `SIGTERM`, `SIGINT`, `stdin.on("end")` call `process.exit(0)` immediately without awaiting `durable.close()`. This leaves `proper-lockfile` unreleased, forcing every thread resume or start to freeze for 10 seconds waiting for stale lock timeout.
  2. `paths.ts` appends `.jsonl` to session path (`thr_xxx.jsonl`), causing SQLite sessions to live in directories named `thr_xxx.jsonl/session.sqlite`.
- **Target Solution:**
  1. In `src/runner/index.ts`, implement graceful shutdown hook: on termination signal, run `await durable.close(); process.exit(0)`.
  2. In `src/host/paths.ts` and `src/host/session.ts`, remove `.jsonl` suffix; standardize on directory paths `~/.bb/pi-bridge-sessions/<sanitizedThreadId>/session.sqlite`, while retaining backward-compatibility for existing `.jsonl` directories.
- **File Impact & Line Budget (AP-019):**
  - `src/runner/index.ts`: +20 lines (keep under 250 lines).
  - `src/host/paths.ts`: refactor session path resolution (~65 lines).
  - `src/host/session.ts`: align session directory args (~160 lines).
- **Test Suite (TDD):**
  - `tests/lifecycle-lock-cleanup.test.ts`: verify sending `SIGTERM` releases lockfile immediately; verify immediate re-acquisition succeeds in < 100 ms without 10-second delay. Verify session directory structure.
- **Verification Gates:**
  - `npm test` passes.
  - No 10-second hang when restarting active thread `thr_ixcw5bus8c`.

---

### Cycle 57: Tool Fault Integrity, Error Reporting & Diff Metadata Forwarding
- **PRD Divergences Covered:** D-5, D-6, D-9.
- **Architectural Problem:**
  1. When a tool task crashes or is orphaned, `event.entry` is `undefined`. `bb-event-adapter.ts` evaluates `entry?.model?.[0]?.isError ?? false`, erroneously reporting fatal tool crashes as successful completions with empty output (violating AP-012/AP-013).
  2. `CodingTools.edit` returns `details: { diff, patch, firstChangedLine }`, but `bb-event-adapter.ts` drops `event.details`, depriving BB Diff Viewer of patch data.
  3. `tool_execution_update` ignores `trimStart` and drops `ToolDiagnostic` warnings.
- **Target Solution:**
  1. In `bb-event-adapter.ts`, if `event.entry === undefined` in `tool_execution_end`, enforce `isError: true` and `result: "Tool execution faulted or was orphaned"`.
  2. Forward `details` (patch, diff, line) into `tool_execution_end`.
  3. In `tool-delta-translator.ts`, map `details.patch` into the `fileChange` item deltas.
  4. Handle `trimStart` and emit diagnostic notifications.
- **File Impact & Line Budget (AP-019):**
  - `src/runner/bridge/bb-event-adapter.ts`: +30 lines (~150 lines).
  - `src/host/tool-delta-translator.ts`: +25 lines (~125 lines).
- **Test Suite (TDD):**
  - `tests/tool-fault-and-diff.test.ts`: test tool execution with `entry === undefined` returns `isError: true`; test `edit` tool produces `patch` in `item.close` delta.
- **Verification Gates:**
  - `npm test` passes.
  - Diff viewer renders syntax-highlighted patches in BB IDE chat.

---

### Cycle 58: Full Native Event Streaming & Multi-Block Reasoning Channels
- **PRD Divergences Covered:** D-3, D-4, D-10.
- **Architectural Problem:**
  1. `bb-event-adapter.ts` hardcodes `contentIndex: 0` for all thinking and text deltas, corrupting streams when multiple reasoning blocks or text parts occur.
  2. Dropped native events: `snapshot`, `auto_retry_start/end`, `deferred_poll`, `task_failed`, `agent_changed`.
  3. Reconnecting to a running session drops active in-flight tool and thinking states because `snapshot` is ignored.
- **Target Solution:**
  1. In `bb-event-adapter.ts`, map `change.contentIndex` directly from `MessageChange` into `assistantMessageEvent.contentIndex` and `key: { channel: "thinking-${contentIndex}" }`.
  2. Handle `snapshot`: replay currently running tools (`live.tools`) and active generation message on attachment.
  3. Handle `auto_retry_start/end`: emit `item.progress` with retry count and backoff delay.
  4. Handle `task_failed`: emit failure boundary delta.
- **File Impact & Line Budget (AP-019):**
  - `src/runner/bridge/bb-event-adapter.ts`: +40 lines (~180 lines).
  - `src/host/delta-translator.ts`: handle retry progress and multi-index thinking channels (~220 lines).
- **Test Suite (TDD):**
  - `tests/event-stream-parity.test.ts`: test multi-block thinking preserves separate channels; test snapshot restores in-flight tools; test auto-retry emits progress notifications.
- **Verification Gates:**
  - Unit tests pass.
  - Reconnecting to busy thread immediately renders ongoing thinking and active tools.

---

### Cycle 59: Model Reasoning Compatibility & Cumulative Usage Integrity
- **PRD Divergences Covered:** D-7, D-8.
- **Architectural Problem:**
  1. `delta-translator.ts` duplicates single-turn `last` usage into session `total` usage upon `agent_end`, resetting total session cost every turn (violating AP-013).
  2. `setThinkingLevel` throws when called on non-reasoning models (`!model.reasoning`), even when setting `off`/`none`. `catalog.ts` falsely advertises reasoning efforts for non-reasoning models.
- **Target Solution:**
  1. In `runtime.ts`, make `setThinkingLevel("off" | "none")` a safe no-op on non-reasoning models instead of throwing.
  2. In `catalog.ts`, inspect `model.reasoning` before advertising `supportedReasoningEfforts`.
  3. In `src/host/delta-translator.ts` and `src/runner/index.ts`, track cumulative session usage across all turns from `docs["pi.usage"]` and emit true monotonic `total` metrics.
- **File Impact & Line Budget (AP-019):**
  - `src/runner/runtime.ts`: update `setThinkingLevel` guard (~20 lines).
  - `src/host/catalog.ts`: filter reasoning efforts (~120 lines).
  - `src/host/delta-translator.ts`: accumulate usage correctly (~230 lines).
- **Test Suite (TDD):**
  - `tests/reasoning-compat-and-usage.test.ts`: test selecting Claude 3.5 Sonnet / GPT-4o with thinking `off` succeeds; test 3-turn conversation accumulates monotonic `totalTokens`.
- **Verification Gates:**
  - `npm test` passes.
  - Non-reasoning models spawn and chat cleanly in BB IDE; Context bar accumulates total tokens accurately.

---

### STAGE 2: ADVANCED ENGINE CAPABILITIES & FULL PARITY (Cycles 60–67)

---

### Cycle 60: Checkpoint Thread Forking & History Branching (`thread/fork`)
- **PRD Epics Covered:** FR-1, FR-2, UJ-1, JTBD-2.
- **Target Solution:**
  1. Add IPC command `fork` to runner.
  2. Implement `src/runner/fork.ts` (< 150 lines) using `@earendil-works/pi-durable`'s `prepareForkDocumentCopies` and `conversation.fork(checkpointEntryId, { ownership: { kind: "ownerless" } })`.
  3. Mint a fresh provider UUIDv7 `sessionId` in `pi.provider` for model prompt cache isolation.
  4. In `src/host/bridge.ts` and `src/host/session.ts`, forward `sourceProviderThreadId` and checkpoint to runner upon `thread/fork`.
- **File Impact & Line Budget (AP-019):**
  - `src/runner/fork.ts`: new file (~110 lines).
  - `src/runner/index.ts`: wire command (~20 lines).
  - `src/host/bridge.ts`: +15 lines.
  - `src/host/session.ts`: +20 lines.
- **Test Suite (TDD):**
  - `tests/thread-fork.test.ts`: fork at checkpoint 5 of 10-turn session; assert child session contains exact documents up to entry 5, has a new provider UUID, and accepts prompts referencing checkpoint history.
- **Verification Gates:**
  - `npm test` passes.
  - Live BB CLI check: `bb thread fork <thread-id>`.

---

### Cycle 61: Provider Usage & Granular Spend Ledger (`provider/usage`)
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

### Cycle 62: Visual Subagent Delegation Cards & Hierarchy (`type: "delegation"`)
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

### Cycle 63: Live Task Graph Synchronization (`harness.taskGraph()`)
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

### Cycle 64: Advanced Inbox Queuing & Cancellation (`submission.abort` & `write`)
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

### Cycle 65: Context Handoff Reset (`/reset`) & Compaction Policies
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

### Cycle 66: Tool Replay Safety & Dynamic Runtime Expansion (`replay` & `control`)
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

### Cycle 67: Custom Durable Chord Documents (`defineDoc`) & Master Conformance
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
