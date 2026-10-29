# Plan: Arch Improvement Cycle 85 — Reverse Chronology in Task Graph & Preview

**Goal:** Invert task ordering in the Beyond Boundaries Task Graph so that the freshest / most recent tasks appear at the top (`b.id - a.id`), active tasks precede finished tasks, and folded history collapses older tasks beneath the 5 most recent ones.

**Architecture Context Map:**
- `src/ui/runtime-graph/tree-order.ts`: `sortTreeActiveFirst` sorts active and finished groups by descending ID (`b.id - a.id`).
- `src/ui/runtime-graph/tree-preview.ts`: `computePreviewFinishedIds` retains the top `targetFinishedCount` most recent finished tasks (`b.id - a.id`), folding older tasks under `See more`.
- `src/ui/runtime-graph/tree.tsx`: `renderBranch` orders active and finished tasks by descending ID (`b.id - a.id`).
- `tests/ui/runtime-graph-active-first-and-folding.test.ts`: Unit tests for ordering and folding.
- `tests/ui/runtime-graph-preview.test.ts`: Tests for preview slice visibility (newest 5 visible, older hidden).
- `tests/ui/runtime-graph-breadcrumbs-and-root-folding.test.ts`: Integration tests for breadcrumbs and root folding.

**Triaged Findings:**
- `[P1] fix-now`: Task graph currently displays oldest tasks at the top due to `a.id - b.id` sort order in `tree-order.ts`, `tree-preview.ts`, and `tree.tsx`. This causes long conversations to show stale initial turns and hide the newest active/recent work.

---

### Task 1: TDD Tests for Reverse Chronology (RED)
- [ ] Update `tests/ui/runtime-graph-active-first-and-folding.test.ts`:
  - Assert that active tasks and finished tasks are sorted newest first (`b.id - a.id`).
  - Assert that preview shows the freshest finished tasks, not the oldest.
- [ ] Update `tests/ui/runtime-graph-preview.test.ts`:
  - For 100 finished tasks, tasks #100..#96 are visible, tasks #95..#1 are hidden behind `See more (95 completed)`.
- [ ] Run `node --test tests/ui/runtime-graph-active-first-and-folding.test.ts tests/ui/runtime-graph-preview.test.ts` to confirm RED failure against unedited code.

### Task 2: Implement Reverse Chronology in UI Graph (GREEN)
- [ ] In `src/ui/runtime-graph/tree-order.ts`:
  - Update `sortTreeActiveFirst` to sort both `active` and `finished` using `b.id - a.id`.
- [ ] In `src/ui/runtime-graph/tree-preview.ts`:
  - Update `computePreviewFinishedIds` to sort `finished` using `b.id - a.id` before taking `previewSlice`.
- [ ] In `src/ui/runtime-graph/tree.tsx`:
  - Update `renderBranch` to sort both `active` and `finished` using `b.id - a.id`.
- [ ] Run `node --test tests/ui/runtime-graph-active-first-and-folding.test.ts tests/ui/runtime-graph-preview.test.ts` to confirm GREEN.

### Task 3: Regression Verification & Breadcrumbs Check
- [ ] Verify `tests/ui/runtime-graph-breadcrumbs-and-root-folding.test.ts` and update fixtures if they assert ascending IDs.
- [ ] Run full test suite: `npm test`.
- [ ] Verify line budgets: strictly < 200 lines for all modified files (AP-019).
- [ ] Run `node scripts/verify-import-graph.mjs` (0 cycles).
- [ ] Run `npx tsc --noEmit` (0 type errors).

### Task 4: Two-Circuit Parallel Verification (S9)
- [ ] Circuit 1: Architectural Reviewer (`arch-rules-implementation-review`).
- [ ] Circuit 2: Product Reviewer (`arch-improvement-product-review`).

### Task 5: Ledger Update & Version Bump
- [ ] Bump version in `package.json` and `package-lock.json` from `0.3.15` to `0.3.16`.
- [ ] Run `npm run build` to update `dist/` bundles.
- [ ] Write Cycle 85 section in `docs/arch-improvement/ledger.md`.
- [ ] Update `docs/arch-improvement/memory.md` with the ordering invariant lesson.
