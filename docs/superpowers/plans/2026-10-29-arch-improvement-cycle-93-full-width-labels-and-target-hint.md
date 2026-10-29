# Arch Improvement Cycle 93: Full-Width Labels & 128-Char Target Hint Plan

**Date:** 2026-10-29  
**Cycle:** 93  
**Goal:** Eliminate premature 48-char backend clipping of `targetHint` and strip redundant `· waiting on N` from parent generation labels, allowing full file paths and commands to display across available width.

## Context & Architecture
- Files: `src/runner/task-labels.ts`, `src/ui/runtime-graph/node-row.tsx`
- Governed by: `/Users/vanya/Projects/AGENTS.md` & `arch-rules.md` (AP-010 – AP-071)
- Line Budget (AP-019): All `.ts` / `.tsx` files strictly < 200 LOC.

## Problem Statement
Even after removing CSS `max-w-[220px]`, rows in the Task Graph were still truncated with ellipsis after ~48 characters (e.g. `read: /Users/vanya/Projects/arch-rules-skills/skills/...`).
Root causes:
1. `src/runner/task-labels.ts`: `sanitizeTargetHint` called `clip(s)` with `MAX_NAME = 48`, prematurely clipping target paths and commands at 48 characters even though the wire schema allows up to 128 characters.
2. `src/ui/runtime-graph/node-row.tsx`: `resolveItemLabel` retained the `· waiting on N` suffix in the title of waiting generation nodes, which together with `max-w-[140px]` caused the parent generation label to truncate to `assistant turn · gpt-6.1-sol (high) · ...`.

## Tasks

- [x] **Task 1: Backend Target Hint Length Alignment (`src/runner/task-labels.ts`)**
  - Introduce `MAX_TARGET_HINT = 128` aligned with `schema.ts`.
  - Allow `sanitizeTargetHint` to preserve target paths up to 128 characters.
  - Keep `preview` bounded to `MAX_NAME = 48` for legacy `taskSteps` compatibility.

- [x] **Task 2: UI Label Cleaning & Breadcrumb Parent Width (`src/ui/runtime-graph/node-row.tsx`)**
  - In `resolveItemLabel`: strip redundant ` · waiting on N` from generation labels (since the amber badge already displays waiting task IDs).
  - Expand parent breadcrumb segment max-width to `max-w-[280px]` so model and provider names fit without ellipsis.

- [x] **Task 3: TDD Regression Tests (`tests/ui/runtime-graph-responsive-width.test.ts`)**
  - Add test verifying `sanitizeTargetHint` preserves paths longer than 48 characters up to 128 characters.
  - Add test verifying waiting turn strips ` · waiting on N` and parent span has expanded max width.

- [ ] **Task 4: Release, Ledger, Memory, Patch Bump & Plugin Update**
  - Bump version in `package.json` and `package-lock.json` from `0.3.23` to `0.3.24`.
  - Rebuild with `npm run build`.
  - Update `docs/arch-improvement/ledger.md` and `docs/arch-improvement/memory.md`.
  - Commit and push to `main`.
  - Tag `v0.3.24` and push.
  - Run `bb plugin update provider-pi-durable --yes`.
