# Architecture Improvement Cycle 88: Active Step Tokens Sum (in + out + reasoning)

**Date:** 2026-10-29  
**Goal:** Calculate step tokens as the honest active sum of uncached tokens for that step (`in + out + reasoning`), instead of showing output tokens only.  
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

1. **[P1] Step Token Calculation Omits Input and Reasoning Tokens:**
   - **Evidence:** For task with `2,891 in · 85 out · 29 reasoning`, the row displayed `85` because only `tokensUsage.output` was used.
   - **Impact:** Misrepresents the actual token cost and consumption of the turn by ignoring the 2,891 input tokens.
   - **Rule:** AP-026 (Honesty & Determinism).
   - **Fix:** Define `calculateStepTokens(usage)` that computes `(input ?? 0) + (output ?? 0) + (reasoning ?? 0)`, representing all new/uncached tokens processed on that turn. Update hover tooltip to reflect the breakdown.

---

## Tasks / Slices

- [ ] **Task 1 (TDD Red):** Add tests for `calculateStepTokens` with input + output + reasoning, verifying that `2891 in + 85 out + 29 reasoning` sums to `3005` (`3.0k`).
- [ ] **Task 2 (Implementation):** Add `calculateStepTokens` in `token-format.ts`, use it in `node-row.tsx`, and pass detailed breakdown to `NodeRowMetrics`.
- [ ] **Task 3 (Regression & Line Budgets):** Run `npm test`, verify all touched files < 200 LOC (AP-019), verify acyclic graph.
- [ ] **Task 4 (Ledger & Version Bump):** Bump to `0.3.19`, build bundles, update `ledger.md` and `memory.md`, tag and push.
