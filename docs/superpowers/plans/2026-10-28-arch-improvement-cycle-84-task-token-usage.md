# Arch Improvement Cycle 84: Live and Terminal Task Token Usage in Task Graph

**Date:** 2026-10-28  
**Cycle:** 84  
**Goal:** Display live and terminal token usage in the task row before timing, updating on the fly, with detailed breakdown in Details panel.

## Context & Architecture
- Architecture Spec: `docs/superpowers/specs/2026-10-28-live-and-terminal-task-tokens-spec.md`
- Governed by: `/Users/vanya/Projects/AGENTS.md` & `arch-rules.md` (AP-010 – AP-071)
- Line Budget (AP-019): All `.ts` / `.tsx` files strictly < 200 LOC.

## Tasks

- [ ] **Task 1: DTO & Contracts Extension (`src/runtime-graph/types.ts` & `src/runtime-graph/schema.ts`)**
  - Define `TaskTokensUsage` interface.
  - Extend `RuntimeTaskNode` with `readonly tokens?: TaskTokensUsage`.
  - Extend `RuntimeTaskReceipt` with `readonly tokens?: TaskTokensUsage`.
  - Extend schema validation in `schema.ts`.
  - Line budget target: < 170 LOC.

- [ ] **Task 2: Token Formatter Module (`src/ui/runtime-graph/token-format.ts`)**
  - Implement `formatTokens(tokens?: number): string | null`.
  - Implement `formatDetailedTokens(tokens?: TaskTokensUsage): string | null`.
  - Line budget target: < 60 LOC.

- [ ] **Task 3: Token Extraction Helper (`src/runner/task-tokens.ts`)**
  - Implement `extractLiveTokens(node, current)` for running `pi.generation`.
  - Implement `extractTerminalTokens(task, current)` from `AssistantEntry` in conversation log.
  - Line budget target: < 90 LOC.

- [ ] **Task 4: Mapper & Receipts Integration (`src/runner/runtime-graph-mapper.ts` & `runtime-graph-receipts.ts`)**
  - In `buildMappedNode`: populate `tokens: extractLiveTokens(node, current)`.
  - In `recordTerminalWithDetails`: pass `tokens: extractTerminalTokens(task, current)`.
  - Maintain `runtime-graph-mapper.ts` strictly < 195 LOC.

- [ ] **Task 5: UI Integration (`src/ui/runtime-graph/node-row.tsx` & `details.tsx`)**
  - In `node-row.tsx`: render `formatTokens(tokens)` before `duration`. Maintain < 195 LOC.
  - In `details.tsx`: render `Tokens` row with detailed breakdown when available. Maintain < 185 LOC.

- [ ] **Task 6: TDD Suite & Dual-Circuit Verification**
  - Add unit test suite in `tests/ui/runtime-graph-tokens.test.ts`.
  - Run all tests (`npm test` — all 648+ tests pass).
  - Run contracts test (`npm run test:contracts`).
  - Run typecheck (`npx tsc --noEmit` — 0 errors).
  - Run Tarjan AST import verification (`node scripts/verify-import-graph.mjs` — 0 cycles).

- [ ] **Task 7: Build, Ledger & Patch Bump (`0.3.14` → `0.3.15`)**
  - Update `docs/arch-improvement/ledger.md` with Cycle 84 receipt.
  - Bump version in `package.json` and `package-lock.json` to `0.3.15`.
  - Run `npm run build`.
  - Commit and push to `main` with tag `v0.3.15`.
