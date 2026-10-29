# Arch Improvement Cycle 92: Responsive Row Width & Elimination of Artificial Label Truncation

**Date:** 2026-10-29  
**Cycle:** 92  
**Goal:** Eliminate artificial fixed pixel widths (`max-w-[170px]` and `max-w-[220px]`) in `RuntimeGraphNodeRow`, allowing task labels and target paths to fluidly utilize available horizontal card width with flexbox `min-w-0` truncation.

## Context & Architecture
- Code: `src/ui/runtime-graph/node-row.tsx`
- Governed by: `/Users/vanya/Projects/AGENTS.md` & `arch-rules.md` (AP-010 – AP-071)
- Line Budget (AP-019): All `.ts` / `.tsx` files strictly < 200 LOC.

## Problem Statement
In `src/ui/runtime-graph/node-row.tsx`, task labels were clamped by hardcoded Tailwind classes:
- Single-child breadcrumb child label had `max-w-[170px]` (~28 characters).
- Leaf task label had `max-w-[220px]` (~35 characters).
In modern desktop BB IDE views, the task graph card is typically 600px–1000px wide. Because `NodeRowMetrics` on the right uses `ml-auto`, these fixed pixel ceilings left hundreds of pixels of blank empty space between the prematurely truncated command/path (e.g. `read: /Users/vanya/Projects/pi-work...`) and the right-aligned metrics, degrading usability.

## Tasks

- [ ] **Task 1: Fluid Label Widths (`src/ui/runtime-graph/node-row.tsx`)**
  - In `singleChild` breadcrumb:
    - Keep parent segment bounded with `truncate max-w-[140px] flex-shrink-0`.
    - Change child segment from `max-w-[170px]` to `truncate min-w-0 font-medium`.
  - In leaf rows:
    - Change label from `max-w-[220px]` to `truncate min-w-0`.
  - Ensure line count remains strictly < 200 LOC.

- [ ] **Task 2: TDD Test Coverage (`tests/ui/runtime-graph-responsive-width.test.ts`)**
  - Assert that `node-row.tsx` does NOT contain hardcoded `max-w-[170px]` or `max-w-[220px]`.
  - Assert that rendered rows include `min-w-0` class for fluid expansion.
  - Verify full test suite passes (`npm test`).

- [ ] **Task 3: Dual-Circuit Verification (S9 Gate)**
  - Architecture Reviewer: check AP rules (AP-010, AP-019, AP-026, AP-028) and line budget.
  - Product Reviewer: verify end-to-end UX, absence of overflow, and readability of long commands/paths.

- [ ] **Task 4: Build, Ledger, Memory, Patch Bump & Marketplace Update**
  - Reserve patch bump in `package.json` and `package-lock.json` (`0.3.22` → `0.3.23`).
  - Run `npm run build` to regenerate `dist/`.
  - Update `docs/arch-improvement/ledger.md` (Cycle 92) and `docs/arch-improvement/memory.md`.
  - Commit and push to `main`.
  - Create and push tag `v0.3.23`.
  - Run `bb plugin update provider-pi-durable --yes`.
