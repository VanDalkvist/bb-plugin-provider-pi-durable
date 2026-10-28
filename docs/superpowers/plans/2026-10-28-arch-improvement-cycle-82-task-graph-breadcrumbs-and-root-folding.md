# Arch Improvement Cycle 82: Task Graph Breadcrumbs & Root-Only History Folding Plan

**Date:** 2026-10-28  
**Cycle:** 82  
**Goal:** Eliminate multi-line task expansion and parasitic nested `See more` buttons for single-tool generation turns, implement 1-line breadcrumbs, default-collapsed multi-child tasks, and root-only history folding.

## Context & Architecture
- Architecture Spec: `docs/superpowers/specs/2026-10-28-task-graph-breadcrumbs-and-root-folding-spec.md`
- Governed by: `/Users/vanya/Projects/AGENTS.md` & `arch-rules.md` (AP-010 – AP-071)
- Line Budget (AP-019): All `.ts` / `.tsx` files strictly < 200 LOC.

## Tasks

- [ ] **Task 1: Root-Only History Folding (`src/ui/runtime-graph/tree-preview.ts`)**
  - Refactor `tree-preview.ts` to compute folding strictly for the root-level list of tasks.
  - Remove global whole-tree traversal that leaked IDs into nested branches.
  - Line budget target: < 150 LOC.

- [ ] **Task 2: Breadcrumb Node Row (`src/ui/runtime-graph/node-row.tsx`)**
  - Support `singleChild?: TaskTreeItem` in `RuntimeGraphNodeRowProps`.
  - When `singleChild` is present:
    - Render parent label + `›` + child label on a single line.
    - Status icon and error indicators reflect child/active status.
    - No chevron button; render alignment spacer `w-4 h-4`.
    - Clicking parent segment selects parent; clicking child segment selects child.
  - When `item.children.length >= 2`:
    - Render chevron button.
    - Show `(${item.children.length} tasks)` count hint.
  - Line budget target: < 190 LOC.

- [ ] **Task 3: Tree Hierarchical Rendering (`src/ui/runtime-graph/tree.tsx`)**
  - Flatten single-child items: if `item.children.length === 1`, pass `singleChild` to `RuntimeGraphNodeRow` and do not recurse into a child branch.
  - Default collapsed state for multi-child items: nodes with $\ge 2$ children default to collapsed unless `hasActiveWork(item)` is true or user explicitly expanded.
  - Restrict `HistoryToggle` strictly to root level: child branches never render `See more / See less`.
  - Render `See more (N completed)` toggle at the bottom of the root list.
  - Line budget target: < 180 LOC.

- [ ] **Task 4: TDD Suite & Test Realignment**
  - Create `tests/ui/runtime-graph-breadcrumbs-and-root-folding.test.ts`.
  - Realign previous tests in `tests/ui/` that asserted on obsolete nested `See more` buttons.
  - Verify all tests pass with `npm test`.

- [ ] **Task 5: Verification, Dist Build, Ledger & Patch Bump**
  - Validate line budgets: `wc -l` on all modified files < 200 LOC.
  - Bump version in `package.json` and `package-lock.json` from `0.3.12` to `0.3.13`.
  - Run `npm run build` to update `dist/`.
  - Update `docs/arch-improvement/ledger.md` with Cycle 82 receipt.
  - Commit and push to `main`.
