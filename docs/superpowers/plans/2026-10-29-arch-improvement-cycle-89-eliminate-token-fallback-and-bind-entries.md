# Architecture Improvement Cycle 89: Eliminate Token Fallback & Exact Entry Binding

**Date:** 2026-10-29  
**Goal:** Eliminate the forbidden silent fallback in `extractTerminalTokens` that assigned the latest assistant entry's tokens to unrelated tasks, and bind entries synchronously from `pub.changes` (`type: "entry"`).  
**State Machine Phase:** S6 (Plan Write)  
**Target Files:**
- `src/runner/task-tokens.ts` (< 200 LOC)
- `src/runner/runtime-graph-source.ts` (< 200 LOC)
- `src/runner/runtime-graph-mapper.ts` (< 200 LOC)
- `src/runner/runtime-graph-receipts.ts` (< 200 LOC)
- `tests/ui/runtime-graph-tokens.test.ts` (< 200 LOC)
- `docs/arch-improvement/ledger.md`
- `docs/arch-improvement/memory.md`

---

## Findings Selected for Fix-Now

1. **[P0] Silent Fallback Violates AP-026 (Tasks Steal Other Tasks' Token Usage):**
   - **Evidence:** In `src/runner/task-tokens.ts`, when `entryId` was not found in `cur.conversation.entries`, a fallback loop took `entries[entries.length - 1]` (the previous assistant entry). In live threads (e.g. `@thread:thr_axjptvcdki`), task #9153 showed `350,834 total` (identical to task #9148), even though in sqlite entry 9154 had `354,709 total (544 in · 3,445 out · 3,106 reasoning · 350,720 cache)`.
   - **Impact:** Complete data corruption of task token metrics across consecutive turns.
   - **Rule:** AP-026 (No silent fallbacks, no guessing, no inventing state).
   - **Fix:** Remove the fallback loop completely. If `entryId` is not found, return `undefined`.

2. **[P1] View Lags Behind Commit Stream for Terminal Generation Tasks:**
   - **Evidence:** When `harness.subscribeCommits` emits `{ type: "task", value: task }`, `viewSource.current()` does not yet contain the new entry committed in the transaction.
   - **Impact:** Terminal tasks fail to find their `entryId` in `viewSource.current()`.
   - **Rule:** AP-010 / AP-026.
   - **Fix:** In `RuntimeGraphSource`, capture `{ type: "entry", value: record }` from `pub.changes` into a bounded `recentEntries` map, and check it first in `extractTerminalTokens`. On view update, backfill any receipts missing tokens whose `entryId` has now landed in view.

---

## Tasks / Slices

- [ ] **Task 1 (TDD Red):** Add negative tests in `tests/ui/runtime-graph-tokens.test.ts`:
  - When `entryId` is not in entries, `extractTerminalTokens` returns `undefined`, NEVER falls back to an older entry.
  - When `entryId` is in `recentEntries`, `extractTerminalTokens` resolves it immediately.
- [ ] **Task 2 (Implementation):**
  - In `src/runner/task-tokens.ts`: Remove the backwards fallback loop. Add support for `recentEntries` lookup.
  - In `src/runner/runtime-graph-source.ts`: Capture `type: "entry"` from `pub.changes` and pass to `recordTerminalWithDetails`. Reconcile missing tokens on view update. Keep file < 200 LOC.
- [ ] **Task 3 (Regression & Line Budgets):** Verify 100% tests pass (`npm test`), verify all files strictly < 200 LOC (AP-019), verify acyclic import graph.
- [ ] **Task 4 (Ledger & Version Bump):** Bump to `0.3.20`, build bundles, update `ledger.md` and `memory.md`, tag and push.
