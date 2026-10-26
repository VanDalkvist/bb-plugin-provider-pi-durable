# G3 UI Slice Plan: Runtime Task Graph Tree & Inspector in BB

**Date:** 2026-10-26  
**Cycle:** Cycle 105 / Arch-Loop 0.3.x Slice G3  
**Target Repository:** `/Users/vanya/Projects/bb-plugin-provider-pi-durable`  
**Governing Artifacts:**
- `docs/superpowers/plans/2026-10-25-runtime-task-graph.md` (Slice G3)
- Parent `runtime-graph-plan-and-ui-policy-recovery.md` (Governing decisions & implementation brief)
- AP Rules: AP-010, AP-019, AP-051, AP-052, AP-054, AP-069

---

## 1. Objectives & Boundaries

### In Scope
1. Implement official BB context segment slot registration in `app.tsx`:
   - `id: "runtime-graph"`, `title: "Ход выполнения"`, `group: "2_runtime"`
   - `summary`: `RuntimeGraphSummary`
   - `details`: `RuntimeGraphSegmentDetails`
   - `useVisible`: `useRuntimeGraphVisible`
2. Implement semantic UI modules in `src/ui/runtime-graph/` (strictly < 200 lines each):
   - `types.ts`: Tree item and UI state definitions.
   - `tree-builder.ts`: Pure tree builder mapping live nodes + receipts by ownership.
   - `use-runtime-graph-state.ts`: Hook managing subscription, state transitions, epoch reset, selection.
   - `use-runtime-graph-visible.ts`: Hook gating visibility for `pi-durable` provider threads.
   - `summary.tsx`: Compact context summary line above composer.
   - `node-row.tsx`: Tree node row with status icon, chevron, labels, wait badge, tool error badge, hover.
   - `tree.tsx`: Bounded tree container with selection and collapse/expand.
   - `details.tsx`: Bounded details inspector with safe data presentation.
   - `segment.tsx`: Bounded container hosting tree and inspector side-by-side with independent scrolling.
   - `index.ts`: Public module exports.
3. Unit and behavioral tests in `tests/ui/`:
   - `runtime-graph-tree-builder.test.ts`
   - `runtime-graph-ui.test.ts`
   - `runtime-graph-segment.test.ts`

### Out of Scope (Strict Non-Interference)
- No runner or host transport changes (G2 / post-restart is verified by parallel worker).
- No package.json version bump (remains 0.3.0).
- No new external runtime npm dependencies.
- No mutating controls (strictly read-only).
- No unescaped HTML or raw argument leaking.
- No border-color jitter on hover.

---

## 2. Invariants & AP Rules

- **AP-010 (Modular Monolith & Ports):** UI imports DTO and status contracts from `src/runtime-graph/`, never deep internals.
- **AP-019 (File line budget):** Every new or modified source file strictly < 200 lines.
- **AP-051 (Frontend feature boundaries):** Standard React with BB SDK 0.6.79 primitives (`experimental_Icon`, `experimental_DetailRow`, `experimental_InfoSection`, etc.).
- **AP-052 (Single Source of Truth):** Reads live state strictly via `readRuntimeGraphSnapshot` / `subscribeRuntimeGraph`.
- **AP-054 (Safe presentation):** Bounded text previews, no script injection.
- **AP-069 (Subtle Elevation):** Hover styling via soft background and shadow (`hover:bg-muted/40 hover:shadow-sm`), no border-color changes.

---

## 3. TDD Steps

1. **RED:** Write focused unit tests for `buildTaskTree` and UI rendering in `tests/ui/`.
   - Assert tree hierarchy follows `owner` and `conversations[id].owner.taskId`.
   - Assert fork-parent is not ownership.
   - Assert wait link is an auxiliary badge, not an execution parent.
   - Assert `completing` status is not confused with final success.
   - Assert tool `isError` is a distinct badge, not rewritten outcome.
   - Assert summary displays counts, errors, and limited badge.
   - Assert details inspector displays exact status, waiting dependencies, sleep deadline, bounded preview.
   - Assert selection and collapse behavior.
   - Run tests to verify expected RED failures.
2. **GREEN:** Implement all modules in `src/ui/runtime-graph/` and register in `app.tsx`.
3. **VERIFY:** Run `npx tsc --noEmit`, contract checks, and full `npm test`. Verify line count limits.
4. **DOCUMENT:** Write comprehensive results to parent storage `/Users/vanya/.bb/thread-storage/thr_ct3kk9xne6/g3-runtime-graph-ui-result.md`.
5. **COMMIT & PUSH:** Commit and push own changes to `origin/main`.
