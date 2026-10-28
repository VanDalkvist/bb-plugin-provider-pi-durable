# Arch Improvement Cycle 83: Subagent Active Status, Enriched Naming & Fixed Details Layout

**Date:** 2026-10-28  
**Cycle:** 83  
**Goal:** Fix false completed checkmarks on running subagents, enrich subagent labels while preserving technical prefixes, display subagent task in Details, stabilize segment layout height, and pin Details header.

## Context & Architecture
- Architecture Spec: `docs/superpowers/specs/2026-10-28-subagent-active-status-details-layout-spec.md`
- Governed by: `/Users/vanya/Projects/AGENTS.md` & `arch-rules.md` (AP-010 – AP-071)
- Line Budget (AP-019): All `.ts` / `.tsx` files strictly < 200 LOC.

## Tasks

- [ ] **Task 1: Active Status Bubble-up & Live Timer (`src/ui/runtime-graph/node-row.tsx`)**
  - In `resolveStatusIcon(item)`: if `hasActiveWork(item)` is true, return `{ icon: "Play", colorClass: "text-blue-500", title: "Running (active child work)" }` even if `item.receipt?.outcome === "completed"`.
  - Calculate `liveElapsed` from `item.liveNode?.startedAt ?? item.receipt?.startedAt` when `hasActiveWork(item)` is true, so duration ticks live.
  - Line budget target: < 190 LOC.

- [ ] **Task 2: Subagent Anchor Mapping & Label Enrichment (`src/runner/runtime-graph-mapper.ts`)**
  - Learn subagent metadata from `SubagentsDoc`: associate `anchorTaskId` with subagent record.
  - When mapping `bb.subagent-anchor`, enrich label to `bb.subagent-anchor · subagent: ${name}` while preserving technical prefix.
  - Expose `toolName: "subagent"`, `targetHint: name`, and `preview: task`.
  - Line budget target: < 190 LOC.

- [ ] **Task 3: Details Panel Styling, Header Pinning & Subagent Task Section (`src/ui/runtime-graph/details.tsx`)**
  - Pin header (`flex-shrink-0 border-b pb-1 px-1`), ensuring only the body (`flex-1 overflow-y-auto min-h-0`) scrolls.
  - If `hasActiveWork(selectedItem)` is true, display `Subagent status: Running in background`.
  - Render dedicated `<InfoSection label="Subagent task">` when a task prompt is present, inside a scrollable `<pre>` block (`max-h-32 text-[11px] whitespace-pre-wrap break-all`).
  - Line budget target: < 195 LOC.

- [ ] **Task 4: Segment Layout Stabilization (`src/ui/runtime-graph/segment.tsx`)**
  - Enforce stable height `max-h-64` regardless of `hasSelection`.
  - Set inspector width to `w-72 max-w-[45%]` in wide mode.
  - Line budget target: < 160 LOC.

- [ ] **Task 5: TDD Suite & Verification**
  - Add unit tests in `tests/ui/runtime-graph-subagent-active-and-details.test.ts`.
  - Verify all 643+ tests pass (`npm test`).
  - Verify `npx tsc --noEmit` has 0 errors.
  - Verify Tarjan SCC has 0 cycles.

- [ ] **Task 6: Build, Ledger & Patch Bump (`0.3.13` → `0.3.14`)**
  - Bump version in `package.json` and `package-lock.json`.
  - Run `npm run build` to compile `dist/`.
  - Update `docs/arch-improvement/ledger.md` with Cycle 83 receipt.
  - Commit and push to `main` with tag `v0.3.14`.
