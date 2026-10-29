# Architecture Improvement Cycle 87: Token Step Output Accuracy & Muted Icon Alignment

**Date:** 2026-10-29  
**Goal:** Fix task #785 0-token bug by using direct generation output tokens (`tokens.output`), place `SparklesIcon` before digits without `+` sign for visual stability, and mute icon color to match tabular digits.  
**State Machine Phase:** S6 (Plan Write)  
**Target Files:**
- `src/ui/runtime-graph/token-format.ts` (< 200 LOC)
- `src/ui/runtime-graph/node-row-metrics.tsx` (< 200 LOC)
- `src/ui/runtime-graph/node-row.tsx` (< 200 LOC)
- `tests/ui/runtime-graph-tokens.test.ts` (< 200 LOC)
- `docs/arch-improvement/ledger.md`
- `docs/arch-improvement/memory.md`

---

## Findings Selected for Fix-Now

1. **[P1] Token Accuracy on Generation Tasks (Task #785 displays 0 instead of 320):**
   - **Evidence:** Task #785 details report `367,315 total (2,231 in · 320 out · 152 reasoning · 364,764 cache)`. The row shows `+0` because cross-task `total - prev` produced `367,315 - 367,315 = 0`.
   - **Impact:** Misleading metrics; user sees 0 tokens on an active generation step.
   - **Rule:** AP-026 (Honesty & Determinism).
   - **Fix:** Resolve step tokens using `tokens.output` first, matching `... out` in inspector details.

2. **[P1] UI/UX Alignment: Icon Before Digits, Remove `+` Sign:**
   - **Evidence:** `+320 ✨` causes digits and icon positions to jump horizontally depending on number length and sign.
   - **Impact:** Column misalignment, visual wobbling across rows.
   - **Rule:** AP-069 (Stable Tabular Presentation).
   - **Fix:** Place `SparklesIcon` on the left followed by unsigned number (`✨ 320`), anchoring the icon on a fixed vertical line.

3. **[P2] Visual Restraint: Muted Icon Color:**
   - **Evidence:** `text-amber-500/80` creates excessive contrast and false emphasis.
   - **Impact:** Visual clutter.
   - **Rule:** AP-069 (Visual Restraint).
   - **Fix:** Change icon color to `text-muted-foreground/60` (inheriting digit color).

---

## Tasks / Slices

- [ ] **Task 1 (TDD Red):** Add unit tests in `tests/ui/runtime-graph-tokens.test.ts` for `formatStepTokens`, unsigned token display with left icon, and task #785 output token resolution (320 tokens).
- [ ] **Task 2 (Implementation):** Update `formatStepTokens` in `token-format.ts`, update `NodeRowMetrics` in `node-row-metrics.tsx` with left-aligned muted icon, and update token resolution in `node-row.tsx`.
- [ ] **Task 3 (Regression & Line Budgets):** Verify all tests pass (`npm test`), verify all files are < 200 LOC (AP-019), and check acyclic import graph.
- [ ] **Task 4 (Dual-Circuit Review S9):** Architectural review (AP-010, AP-019, AP-026, AP-028) and Product review.
- [ ] **Task 5 (Ledger & Version Bump):** Bump to `0.3.18`, update `ledger.md` and `memory.md`, build bundles, tag, and update BB plugin.
