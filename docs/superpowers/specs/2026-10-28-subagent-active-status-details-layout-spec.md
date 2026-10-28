# Subagent Active Status Tracking, Enriched Tool Details & Fixed Inspector Spec

**Date:** 2026-10-28  
**Cycle:** 83  
**Component:** `bb-plugin-provider-pi-durable / src/ui/runtime-graph`

## 1. Context & User Feedback

1. **Subagent Active Status Masking:**
   Background subagents run under an `Anchor` task (`bb.subagent-anchor`) that commits `terminal: completed` in 1ms to release the parent conversation. The UI Task Tree displayed `✓ bb.subagent-anchor #466 1ms Completed successfully` with a green checkmark while child tasks (`assistant turn`, `bb.subagent-reporter · deliver`) were still actively running.
2. **Subagent Naming & Task Details:**
   The user wants the technical prefix preserved alongside the tool/task details via a clean separator:
   e.g. `bb.subagent-anchor · subagent: Architectural Reviewer` (or `bb.subagent-anchor · <title>`), with the full task prompt displayed in a dedicated, scrollable section in the Details panel.
3. **Inspector Layout Stability & Header Pinning:**
   - Selecting a task jumped the container height from `max-h-60` to `max-h-72`.
   - The inspector took a rigid `w-80`, crushing the task tree on medium viewports.
   - The Details header must remain strictly pinned at the top and NEVER scroll out of view when scrolling inspector content.
4. **Tool Details Preservation:**
   Keep technical prefixes (`pi.tool`, `bb.subagent-reporter`, etc.) and append tool name and details via separator `·` on the row, with overflow available in Details.

## 2. Invariants & Architecture Decisions

### 2.1 Bubble-up Active State (Honest Activity Reporting)
- In `node-row.tsx`: If `hasActiveWork(item)` is `true` (the item or any of its descendants is currently running or waiting):
  - The status icon must be the active running indicator: `icon: "Play"`, `colorClass: "text-blue-500"`, `title: "Running"`.
  - It MUST NOT display a green checkmark `✓` (`outcome: "completed"`), even if the item itself has a terminal completed receipt (such as `Anchor`).
  - The duration must display live elapsed time (`liveElapsed = now - startedAt`), updating dynamically rather than showing static `1ms`.
  - The green checkmark is displayed ONLY when ALL child work has completed.
- In `details.tsx`: If `hasActiveWork(item)` is `true`, display `Runtime status: Running in background` instead of false completed status.

### 2.2 Subagent Naming & Enriched Task Details
- In `src/runner/runtime-graph-mapper.ts`:
  - When mapping an Anchor node or receipt, check `SubagentsDoc.agents` by `anchorTaskId`.
  - Enriched labels preserve technical kind with details:
    `bb.subagent-anchor · subagent: ${agent.name}`
  - `targetHint` is set to `${agent.name}`, `toolName` is set to `"subagent"`, and `preview` retains the subagent task.
- In `details.tsx`:
  - If a subagent task or prompt is present, render a dedicated `<InfoSection label="Subagent task">` with a scrollable `<pre>` block (`max-h-32 text-[11px] font-mono whitespace-pre-wrap break-all`).

### 2.3 Inspector Layout & Non-Scrolling Header
- In `segment.tsx`:
  - Enforce a constant, stable height (`max-h-64`, 256px) regardless of whether a task is selected or not (`hasSelection`). Zero vertical jumping.
  - Make inspector width flexible and proportional: `w-72 max-w-[45%]` so the tree keeps at least 55% of the horizontal space.
- In `details.tsx`:
  - Header is strictly fixed (`flex-shrink-0 border-b pb-1 px-1`), with `Task Details` title and `X` button.
  - Body content is the sole scrollable container (`flex-1 overflow-y-auto min-h-0 space-y-4 pt-2`). Scrolling content never moves the header.

## 3. Quality & Boundary Rules
- **AP-019 (Line Budgets):** All `.ts` / `.tsx` files strictly < 200 LOC.
- **AP-013 & AP-028 (Deterministic Testing):** Full test suite passes 100%.
- **One Commit = One Patch Bump:** `0.3.13` → `0.3.14`.
