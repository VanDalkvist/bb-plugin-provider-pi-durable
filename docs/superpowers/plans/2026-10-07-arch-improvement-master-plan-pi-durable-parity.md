# Master Architectural Implementation Plan: Full Parity of Pi Durable in BB IDE

**Document ID:** `plans/pi-durable-bb-provider-arch-master-plan`  
**Target Repository:** `/Users/vanya/Projects/bb-plugin-provider-pi-durable`  
**Governing Standard:** `arch-rules.md` (AP-010 – AP-071) & `arch-improvement-loop` State Machine  
**Upstream PRD:** `prd/pi-durable-bb-provider-full-parity` (v2.0.0 Master Specification)  
**Execution Model:** 8 Distinct Sequential Arch Improvement Loop Cycles (Cycle 56 to Cycle 63) executed in dedicated threads with strict gates.

---

## 1. Architectural Guardrails & Invariants (AP Rules)

Every cycle must strictly comply with the baseline and critical architectural rules:
1. **AP-010 (Modular Monolith & Ports/Adapters):** Clean separation between Host Bridge (Interface), Session Management (Application), and Runner Process (Infrastructure Port).
2. **AP-012 (Fail-Fast & Explicit Contracts):** No loose type fallbacks. Invalid session paths or unsupported checkpoint entry IDs fail immediately with typed errors.
3. **AP-013 (Data Integrity without Fakes):** Strictly prohibited to forge fake completions, fake fork sessions, or fake tool results. Every state must originate from SQLite / Chord transactions.
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

Every individual cycle (Cycle 56 through 63) must be executed in its own dedicated thread, strictly walking the 13 states:

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

### Required Skills per State:
- **S0:** `arch-improvement-loop`, local instructions (`AGENTS.md`).
- **S1:** `brain-ops`, memory lookup (`mcp__gbrain__recall`).
- **S2:** `arch-rules-context` (Architecture Context Map & file line count audit).
- **S3:** `superpowers:brainstorming` (Hard-gate design confirmation with user).
- **S4/S5:** `arch-improvement-review`, `arch-improvement-ledger`.
- **S6:** `superpowers:writing-plans` (Detailed plan saved in `docs/superpowers/plans/YYYY-MM-DD-arch-improvement-cycle-N.md`).
- **S7:** `superpowers:executing-plans` (Critical pre-execution plan review).
- **S8:** `superpowers:test-driven-development` (Red test -> Green implementation -> Refactor).
- **S9:** `superpowers:verification-before-completion` (Automated tests, static check, live thread evidence).
- **S10:** `arch-improvement-ledger` (Log entry in `.arch-improvement/review-log.md`).
- **S11:** `brain-ops` (Save durable memory fact in gbrain via `mcp__gbrain__remember`).

---

## 3. Dedicated Cycle Specifications

---

### Cycle 56: Checkpoint Thread Forking & History Branching (`thread/fork`)

- **PRD Epics Covered:** FR-1, FR-2, UJ-1, JTBD-2.
- **Architectural Problem:**
  `case "thread/fork"` in `src/host/bridge.ts` ignores `sourceProviderThreadId` and `sourceProviderCheckpointId`, creating an empty session (`pi_durable_${Date.now()}`). Forked threads lose all history.
- **Target Solution:**
  1. Add IPC command `fork` to the runner.
  2. Implement `src/runner/fork.ts` (< 150 lines) using `@earendil-works/pi-durable`'s `prepareForkDocumentCopies` and `conversation.fork(checkpointEntryId, { ownership: { kind: "ownerless" } })`.
  3. Mint a fresh provider UUIDv7 `sessionId` in the forked session's `pi.provider` document for LLM cache isolation.
  4. In `src/host/bridge.ts` and `src/host/session.ts`, forward `sourceProviderThreadId` and checkpoint to the runner upon `thread/fork`.
- **File Impact & Line Budget (AP-019):**
  - `src/runner/fork.ts`: new file (~110 lines).
  - `src/runner/index.ts`: +25 lines (now ~235 lines).
  - `src/host/bridge.ts`: +15 lines (keep under 240 lines by extracting helpers if needed).
  - `src/host/session.ts`: +20 lines (keep under 230 lines).
- **Test Suite (TDD):**
  - `tests/thread-fork.test.ts`: test forking at checkpoint 5 of a 10-entry session; assert child session contains exact documents up to entry 5, has a new provider UUID, and can accept prompts referencing checkpoint history.
- **Verification Gates:**
  - `npm test` passes.
  - Live verification via BB CLI: `bb thread fork <thread-id>`.

---

### Cycle 57: Provider Usage & Granular Spend Ledger (`provider/usage`)

- **PRD Epics Covered:** FR-11, UJ-6, JTBD-5.
- **Architectural Problem:**
  JSON-RPC method `provider/usage` returns `{ supported: false }`. Token usage is only emitted in single-turn deltas; cumulative cost and tool counts are hidden.
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

### Cycle 58: Visual Subagent Delegation Cards & Hierarchy (`type: "delegation"`)

- **PRD Epics Covered:** FR-3, FR-4, UJ-2, JTBD-3.
- **Architectural Problem:**
  Subagents execute inside `subagent` tool calls as raw strings. BB IDE chat cannot render collapsible delegation cards (`item.open (type: "delegation")`), and subagent reasoning/tools bleed into the parent log.
- **Target Solution:**
  1. Update `src/runner/subagent.ts` to assign `ownership: { kind: "task", taskId }` to child conversations.
  2. In `src/runner/bridge/bb-event-adapter.ts`, intercept child conversation events and emit:
     - `item.open` with `type: "delegation"`, `providerItemId: childConversationId`, `subagentName`, `description`.
     - Child reasoning (`reasoningText`) and child tools nested under the delegation card key.
     - `item.close` with status and returned answer.
  3. Update `src/host/tool-delta-translator.ts` to handle `type: "delegation"` deltas.
- **File Impact & Line Budget (AP-019):**
  - `src/runner/bridge/delegation-adapter.ts`: new file (~130 lines) to avoid bloating `bb-event-adapter.ts`.
  - `src/runner/subagent.ts`: refactor to use delegation adapter (~110 lines).
  - `src/host/tool-delta-translator.ts`: +20 lines (keep under 180 lines).
- **Test Suite (TDD):**
  - `tests/subagent-delegation.test.ts`: assert child conversation dispatches proper `item.open (type: "delegation")` and nests tool calls without leaking to root stream.
- **Verification Gates:**
  - Unit tests passing.
  - Visual verification in BB chat: delegation cards collapse/expand and display subagent tools.

---

### Cycle 59: Live Task Graph Synchronization (`harness.taskGraph()`)

- **PRD Epics Covered:** FR-5, UJ-5, JTBD-4.
- **Architectural Problem:**
  Pi Durable maintains a full structured task graph (`harness.taskGraph()`) with dependencies (`waiting on [taskId]`) and failure policies (`failFast`), but none of this is visible in BB IDE.
- **Target Solution:**
  1. In runner, subscribe to `harness.taskGraph(context)`.
  2. Emit `task_graph_update` wire events whenever tasks transition (`pending`, `running`, `waiting`, `completing`, `done`, `failed`).
  3. In `src/host/delta-translator.ts`, map task transitions to BB `backgroundTask` timeline items or plan step items.
- **File Impact & Line Budget (AP-019):**
  - `src/runner/bridge/task-graph-adapter.ts`: new file (~110 lines).
  - `src/host/task-delta-translator.ts`: new file (~100 lines).
  - `src/host/delta-translator.ts`: delegate task events to `task-delta-translator.ts`.
- **Test Suite (TDD):**
  - `tests/task-graph.test.ts`: test dependency graph transitions (`waiting` -> `running` -> `done`) and verify correct wire delta emissions.
- **Verification Gates:**
  - Unit tests passing.
  - Live task status rows appear in BB IDE task panel.

---

### Cycle 60: Advanced Inbox Queuing & Cancellation (`submission.abort` & `write`)

- **PRD Epics Covered:** FR-6, FR-7, FR-8, UJ-3, JTBD-4.
- **Architectural Problem:**
  Users cannot cancel queued steer/follow-up commands in the UI before they execute. System tools cannot record durable audit entries without forcing a model generation.
- **Target Solution:**
  1. Handle `turn/cancel_queued` in `src/host/bridge.ts`, delegating to `session.cancelQueued(clientRequestId)`.
  2. In runner, call `submission.abort()` on the corresponding submission in `docs["pi.inbox"]`.
  3. Add `write_entry` IPC command to runner: calls `conversation.submit({ type: "write", entry })` committing an entry without spawning a LLM generation task.
  4. Support configurable `QueueMode` (`"one-at-a-time"` vs `"all"`).
- **File Impact & Line Budget (AP-019):**
  - `src/host/bridge.ts`: add `turn/cancel_queued` (~15 lines).
  - `src/host/session.ts`: add `cancelQueued` and `writeEntry` (~25 lines).
  - `src/runner/index.ts`: wire commands (~30 lines).
- **Test Suite (TDD):**
  - `tests/inbox-controls.test.ts`: test queuing an item, aborting it while busy, and verifying the LLM never executes it; test writing a passive entry and asserting no LLM call.
- **Verification Gates:**
  - Unit tests passing.
  - Clicking "Cancel" in BB chat feed immediately cancels queued instruction.

---

### Cycle 61: Context Handoff Reset (`/reset`) & Compaction Policies

- **PRD Epics Covered:** FR-9, FR-10, UJ-4, JTBD-5.
- **Architectural Problem:**
  Multi-day sessions accumulate huge token counts. Users have no way to perform a clean context handoff without abandoning the thread and its SQLite history. Compaction thresholds cannot be customized.
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
  - Unit tests passing.
  - Running `/reset Starting phase 2` in chat resets Context Meter and starts clean turn.

---

### Cycle 62: Tool Replay Safety & Dynamic Runtime Expansion (`replay` & `control`)

- **PRD Epics Covered:** FR-12, FR-13, FR-14, UJ-1, UJ-2.
- **Architectural Problem:**
  On crash recovery, all tools default to `replay: "unsafe"` and are interrupted, even read-only tools like `read` or `search`. Tools cannot dynamically expand tools (`addTools`) or terminate turns early (`terminate`).
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
  - Unit tests passing.
  - Simulated crash during `read` re-executes cleanly on restart.

---

### Cycle 63: Custom Durable Chord Documents (`defineDoc`) & Master Conformance

- **PRD Epics Covered:** FR-15, NFR-1..8, All User Journeys (UJ-1 – UJ-6).
- **Architectural Problem:**
  BB extension state (todos, visual workflow checkpoints) cannot be atomically stored in the session SQLite database. System lacks a single master conformance benchmark.
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

## 4. Execution Protocol: How Each Cycle Must Be Run

For each cycle from 56 to 63:
1. **New Dedicated Thread:** A new thread is started (e.g. `@thread:cycle-56-thread-fork`).
2. **Skill Loading:** Load `arch-improvement-loop` and read `arch-rules.md`.
3. **Memory Loading (S1):** Recall existing findings from gbrain (`prd/pi-durable-bb-provider-full-parity`, `plans/pi-durable-bb-provider-arch-master-plan`).
4. **Orientation (S2):** Verify line counts of target files:
   ```bash
   wc -l src/host/*.ts src/runner/*.ts
   ```
5. **Brainstorm Gate (S3):** Present concrete interface design to user before writing code.
6. **Plan Write & Review (S6/S7):** Create `docs/superpowers/plans/YYYY-MM-DD-arch-improvement-cycle-N.md`.
7. **TDD Execution (S8):** Write failing test first -> implement -> pass test -> refactor.
8. **Verification Gate (S9):** Run `npm test`, `npx tsc --noEmit`, and `npm run build`.
9. **Ledger Update (S10):** Append detailed cycle report to `.arch-improvement/review-log.md`.
10. **Learn Gate (S11):** Commit fact to gbrain via `mcp__gbrain__remember`.
