# Cycle 99: Offline Binding Recovery & Unanswered Input Settlement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve Issue #24 (silent offline binding recovery failure on JSON-encoded `documents.kind`) and Issue #23 / F-98-3 (unanswered native input incorrectly reported as `completed` after intermediate `toolUse` progress), enforcing strict AP rules and line budgets.

**Architecture:** 
1. Fix SQL kind matching in `DurableBindingManager.readOfflineBindings` to accept both unquoted and JSON-encoded kind strings (`d.kind IN ('bb.native-child-binding', '"bb.native-child-binding"')`), adding an authoritative real SDK test.
2. Track native submission records and correlate `run_end.inputs` with their terminal status in `BBEventAdapter` and `turn-summary.ts`; when a run ends with an `unanswered` input, emit `isError: true` with stopReason `"error"` and appropriate failure detail, preventing `turn.boundary: { status: "completed" }` while preserving any intermediate partial output.

**Tech Stack:** Node.js 24/26, TypeScript, `@earendil-works/pi-durable`, `@get-bb/plugin-sdk`, `node:sqlite`, `node:test`.

---

## Modularity & Line Budgets (AP-019)

| File | Current Lines | Maximum Budget | Strategy |
|---|---|---|---|
| `src/host/durable-binding-store.ts` | 142 | 250 | Expand SQL `WHERE` clause in place (< 5 lines added) |
| `src/runner/bridge/turn-summary.ts` | 76 | 200 | Add input settlement evaluation to `resolveTurnSummary` (~25 lines added) |
| `src/runner/bridge/bb-event-adapter.ts` | 197 | 200 | Extract submission tracking helper or keep inline delta to <= 3 lines to stay < 200 |
| `tests/durable-binding-store.test.ts` | 271 | N/A | Add real SDK-backed offline binding test |
| `tests/unanswered-settlement.test.ts` | New | N/A | Add deterministic TDD test for Issue #23 |

---

### Task 1: Slice 99.1 — Offline Binding Recovery JSON Kind Matching (Issue #24)

**Files:**
- Modify: `src/host/durable-binding-store.ts:98-103`
- Test: `tests/durable-binding-store.test.ts`

- [ ] **Step 1: Write the failing test for real SDK store**
  Add a test to `tests/durable-binding-store.test.ts` that creates a real SDK session with `openNodeSqliteStorage`, registers a child binding via `tx.doc(BindingDoc, ...)`, closes the storage, and asserts `manager.readOfflineBindings(dir)` recovers the binding.

- [ ] **Step 2: Run test to confirm it fails**
  Run `node --test tests/durable-binding-store.test.ts` and verify it fails (expected: 1, actual: 0).

- [ ] **Step 3: Implement minimal fix in `src/host/durable-binding-store.ts`**
  Change SQL query in `readOfflineBindings`:
  ```sql
  WHERE d.kind IN ('bb.native-child-binding', '"bb.native-child-binding"') AND d.retired_at IS NULL
  ```

- [ ] **Step 4: Run test to verify it passes**
  Run `node --test tests/durable-binding-store.test.ts` and verify all tests pass.

- [ ] **Step 5: Verify AP-019 line budget**
  Ensure `src/host/durable-binding-store.ts` is strictly < 250 lines (`wc -l`).

---

### Task 2: Slice 99.2 — Native Unanswered Input Settlement Failure Mapping (Issue #23 & F-98-3)

**Files:**
- Modify: `src/runner/bridge/turn-summary.ts`
- Modify: `src/runner/bridge/bb-event-adapter.ts`
- Test: `tests/unanswered-settlement.test.ts`

- [ ] **Step 1: Write the failing test for unanswered input with toolUse progress**
  Create `tests/unanswered-settlement.test.ts` simulating a native event batch containing:
  - user input,
  - assistant message with `stopReason: "toolUse"`,
  - `task_failed`,
  - `turn_end`,
  - `run_end` with `inputs: [11]`,
  - `submission` record with `id: 11, status: "unanswered", reason: "faulted", detail: "synthetic fault"`.
  Feed it into `BBEventAdapter` and host `translateAgentEnd`. Assert:
  `turn.boundary.status === "failed"` and error message is populated, retaining any prior progress text.

- [ ] **Step 2: Run test to confirm it fails**
  Run `node --test tests/unanswered-settlement.test.ts` and verify it currently produces `turn.boundary.status === "completed"`.

- [ ] **Step 3: Implement submission tracking and settlement resolution**
  - In `src/runner/bridge/turn-summary.ts`: support checking terminal submission status or explicit run fault reason.
  - In `src/runner/bridge/bb-event-adapter.ts`: buffer `submission` events and match them with `run_end.inputs`. When matching input is `unanswered`, pass `isError: true` and failure details to `emitTerminal("agent_end", ...)`.
  - Maintain AP-019: `bb-event-adapter.ts` must stay < 200 lines (refactor/compact private helper if needed).

- [ ] **Step 4: Run test to verify it passes**
  Run `node --test tests/unanswered-settlement.test.ts` and verify it passes.

- [ ] **Step 5: Run full test suite regression**
  Run `npm test` to verify all existing 282+ tests remain green.

- [ ] **Step 6: Verify AP-019 line budgets**
  Verify `wc -l src/runner/bridge/bb-event-adapter.ts` < 200 and `src/runner/bridge/turn-summary.ts` < 200.

---

### Task 3: Dual-Circuit Verification Gate (S9)

- [ ] **Step 1: Spawn S9a Architecture Review subagent**
  Launch child thread with `--provider pi-durable --model antigravity/gemini-3.8-flash --reasoning-level high` reviewing against AP rules (`AP-010`, `AP-013`, `AP-019`, `AP-026`, `AP-027`, `AP-034`).

- [ ] **Step 2: Spawn S9b Product Review subagent**
  Launch child thread with `--provider pi-durable --model antigravity/gemini-3.8-flash --reasoning-level high` evaluating real offline binding hydration and failure boundary reporting.

- [ ] **Step 3: Confirm Dual PASS verdict**
  Ensure both S9a and S9b issue `VERDICT: PASS`.

---

### Task 4: Ledger & Memory Updates (S10, S11, S12)

- [ ] **Step 1: Update `docs/arch-improvement/ledger.md`**
  Record Cycle 99 entries: findings F-99-1 (Issue #24) and F-99-2 (Issue #23 / F-98-3), test counts, verification evidence, and closed status.

- [ ] **Step 2: Update `docs/arch-improvement/memory.md`**
  Record lessons regarding JSON-encoded SQLite metadata and multi-event transactional batch settlement correlation.

- [ ] **Step 3: Build & Release**
  Run `npm run build`, bump patch version, tag `v0.2.47`, push to GitHub, and update the live BB IDE plugin.
