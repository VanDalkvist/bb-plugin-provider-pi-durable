# Plan: Arch Improvement Cycle 86 — Task Row Tabular Alignment & Token Delta

**Goal:** Clean up the task graph row numbers display:
1. Show token delta from the previous chronological step (`+1.5k`, `+450`, `+16k`, `+0`, `-50k`) instead of raw total context tokens.
2. Replace text `tok` with a crisp, universal token coins icon.
3. Fix the layout of tokens and duration into dedicated, fixed-width tabular slots with a subtle separator (`·`) so numbers never wobble or jump horizontally.

**Architecture Context Map:**
- `src/ui/runtime-graph/types.ts`: add `tokenDelta?: number` to `TaskTreeItem`.
- `src/ui/runtime-graph/tree-builder.ts`: compute `tokenDelta` per `conversationId` in chronological order ($T_i - T_{i-1}$, where $T_1 = total$).
- `src/ui/runtime-graph/token-format.ts`: add `formatTokenDelta(delta?: number): string | null`.
- `src/ui/runtime-graph/token-icon.tsx`: universal token icon SVG (`TokenCoinsIcon`).
- `src/ui/runtime-graph/node-row-metrics.tsx`: dedicated fixed-width tabular metrics container (token delta slot + separator + duration slot).
- `src/ui/runtime-graph/node-row.tsx`: integrate `NodeRowMetrics`, keeping `node-row.tsx` well under 200 lines (AP-019).
- `tests/ui/runtime-graph-tokens.test.ts`: test delta formatting, token coins icon, and fixed metrics container.

---

### Task 1: TDD Tests for Token Delta & Metrics Container (RED)
- [ ] Add unit tests in `tests/ui/runtime-graph-tokens.test.ts`:
  - `formatTokenDelta`: formats positive, zero, and negative deltas (`+1.5k`, `+450`, `+0`, `-15k`).
  - `tree-builder`: computes `tokenDelta` between consecutive generations in the same conversation.
  - `NodeRowMetrics`: renders fixed tabular slots, `TokenCoinsIcon`, and separator `·`.
- [ ] Run `npx tsx --test tests/ui/runtime-graph-tokens.test.ts` to confirm RED failure.

### Task 2: Implement Token Delta & Formatters
- [ ] Update `src/ui/runtime-graph/types.ts` with optional `tokenDelta?: number`.
- [ ] Update `src/ui/runtime-graph/token-format.ts` with `formatTokenDelta`.
- [ ] Update `src/ui/runtime-graph/tree-builder.ts` to compute `tokenDelta` per conversation in chronological order.
- [ ] Create `src/ui/runtime-graph/token-icon.tsx` with Lucide-compatible `TokenCoinsIcon`.

### Task 3: Implement Fixed Tabular Row Metrics
- [ ] Create `src/ui/runtime-graph/node-row-metrics.tsx`:
  - Fixed-width token delta slot (`w-[3.75rem]`, right-aligned, `font-mono tabular-nums`).
  - Token icon (`TokenCoinsIcon`) next to delta with hover title showing total tokens.
  - Fixed separator (`·` with `text-muted-foreground/30 px-1.5`).
  - Fixed-width duration slot (`w-[3rem]`, right-aligned, `font-mono tabular-nums`).
- [ ] Update `src/ui/runtime-graph/node-row.tsx` to use `NodeRowMetrics`.
- [ ] Verify `npx tsx --test tests/ui/runtime-graph-tokens.test.ts` is GREEN.

### Task 4: Regression & Quality Gates
- [ ] Run full test suite: `npm test` (all 655+ tests must pass).
- [ ] Verify line budgets: strictly < 200 lines for all modified and new files (AP-019).
- [ ] Run `node scripts/verify-import-graph.mjs` (0 cycles).
- [ ] Run `npx tsc --noEmit` (0 type errors).

### Task 5: Two-Circuit Parallel Verification (S9)
- [ ] Circuit 1: Architectural Reviewer (`arch-rules-implementation-review`).
- [ ] Circuit 2: Product Reviewer (`arch-improvement-product-review`).

### Task 6: Ledger Update & Release
- [ ] Bump version in `package.json` and `package-lock.json` to `0.3.17`.
- [ ] Run `npm run build` to update dist bundles.
- [ ] Record Cycle 86 in `docs/arch-improvement/ledger.md`.
- [ ] Update `docs/arch-improvement/memory.md`.
