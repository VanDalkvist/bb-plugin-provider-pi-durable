# Runtime Graph Live Truth and English UI Slice Plan

**Date:** 2026-10-27  
**Cycle:** Cycle 105+ / Arch-Loop 0.3.x  
**Target Repository:** `/Users/vanya/Projects/bb-plugin-provider-pi-durable`  
**Role:** UI Writer (isolated worker subagent)  
**Governing Context:**
- Parent Storage: `/Users/vanya/.bb/thread-storage/thr_ct3kk9xne6/`
- User Directive: English-only UI controls/labels; hidden inspector until explicit task selection; live task truth.
- AP Rules: AP-010, AP-013, AP-019, AP-028, AP-051, AP-052, AP-054, AP-069

---

## 1. User Requirements

1. **English-Only Plugin UI Controls & Labels:**
   - All plugin-owned UI labels, titles, summaries, counters, statuses, tooltips, ARIA labels, empty/loading/unavailable/stale/limited states, inspector field labels, settings controls, and validation errors must be in English (overriding prior Russian defaults).
   - Grammatically correct singular and plural task counts (e.g., `1 active task` vs `2 active tasks`).
   - Boundary: User-provided and model-generated content (messages, task descriptions, bash commands, file paths, tool outputs/results, raw error codes/messages) are NOT translated; only the plugin's own interface chrome and labels are English.
   - External core BB UI or tools outside this plugin are not modified.

2. **Live Executing Tasks Representation:**
   - Task graph accurately renders executing and completed tasks in real time without false completion or ghost states.
   - Handled in runtime layer by active runtime writer (`thr_c8kun85294`) and live investigator; UI layer renders live nodes, statuses, and receipts accurately from store contract without rewriting lifecycle.

3. **Conditional Inspector (Hidden Until Explicit Selection):**
   - When no task is selected (`selectedTaskId === null` or `selectedItem === null`), the details inspector panel is NOT mounted and does NOT reserve column width or bottom height. The tree component expands to full available width.
   - No auto-selection on initial load or realtime updates.
   - Explicit selection via click or Enter/Space on a node row opens the inspector. Clicking a branch chevron strictly toggles expand/collapse without triggering selection or opening the inspector.
   - An accessible English close/deselect control (`Close`, `aria-label="Close inspector"`) returns the view to full tree width without mutating task state.
   - If a selected task is pruned or an epoch/thread reset occurs, selection clears and the inspector gracefully unmounts (no empty or stale panel).

---

## 2. Ownership Boundaries

### Runtime Writer Zone (thr_c8kun85294) — DO NOT EDIT:
- `src/runner/stdout-guard.ts`
- `src/runner/runtime-graph-source.ts`
- `src/runner/runtime-graph-receipts.ts`
- Associated runner test suites (`tests/runner-cold-start-protocol.test.ts`, `tests/runtime-graph-completing.test.ts`, etc.)
- Generated runner dist files (`dist/runner/*`)
- Master plan and ledger updates (`docs/arch-improvement/ledger.md`, master roadmap)

### Shared Store/Core Core Review Zone — DO NOT EDIT RIGHT NOW:
- `src/ui/runtime-graph/store.ts`
- `src/ui/runtime-graph/read.ts`
- `src/ui/runtime-graph/subscription.ts`
- `src/ui/runtime-graph/tree-builder.ts`

### UI Writer Zone (This Subagent):
- `src/ui/runtime-graph/segment.tsx`: Conditional inspector rendering, full-width tree layout when unselected, narrow/wide layout handling.
- `src/ui/runtime-graph/details.tsx`: English field labels, close button control callback (`onClose`).
- `src/ui/runtime-graph/node-row.tsx`: English status titles, duration formatting (`ms`/`s`), aria labels (`Expand`/`Collapse`), badges (`waiting`, `tool error`, `aborted`).
- `src/ui/runtime-graph/tree.tsx`: English empty state (`No tasks in graph`).
- `src/ui/runtime-graph/summary.tsx`: English segment title, singular/plural counters (`1 active task` / `N active tasks`), English status & limited/stale badges.
- `app.tsx`: English titles for slots (`Subagents`, `Task Execution`).
- `src/ui/routing-selector.tsx`: English labels, select options, and aria labels.
- `src/ui/settings-subagent-section.tsx`: English settings labels, radio options, explanations, warnings, save/cancel buttons.
- `src/ui/use-subagent-policy.ts`: English error strings (conflict, save failure).
- `src/runtime-graph/status.ts`: English display labels ONLY (lifecycle logic strictly preserved).
- Focused UI tests in `tests/ui/` and `tests/runtime-graph-status.test.ts`.

---

## 3. Acceptance Criteria

1. **English Controls & Labels:**
   - 0 Cyrillic characters remain in `src/ui/` and `src/runtime-graph/status.ts`.
   - Summary displays `1 active task` when count is 1, and `${count} active tasks` when count > 1.
   - Status titles and badges use standard English terms (`Running`, `Waiting on dependencies`, `Waiting for timer`, `Completing child work`, `Queued`, `Completed`, `Execution failed`, `Aborted`, `Runtime fault`, `Orphaned task`, `Tool error`, `Limited`, `Stale`).
   - Settings page displays English headers, radio descriptions, catalog status, error alerts, and action buttons.

2. **Conditional Inspector Behavior:**
   - On load with `selectedTaskId: null`, inspector DOM element is not mounted; tree container takes 100% width without column divider.
   - Clicking node row selects the task and mounts inspector.
   - Clicking branch chevron toggles collapse/expand without selecting task or mounting inspector.
   - Clicking close button in inspector calls deselect and unmounts inspector, returning tree to full width.
   - When selected task is missing from tree items (e.g. pruned snapshot), inspector unmounts automatically.
   - Narrow layout (< 580px) stacks tree and inspector vertically when selected, and occupies full height when unselected.

3. **Invariants & Quality:**
   - All touched and new `.ts`/`.tsx` files strictly < 200 lines.
   - Focused UI tests run and pass without regressions.
   - No runner files or runner dist touched.
   - Changes committed and pushed to `origin/main` using precise git adds.

---

## 4. Amendment 2: Active-First Ordering, Folded History, Native Density, and Bounded View Clock

**Approved user design specifications:**
1. **Title and Active Counter Labels:**
   - Title: `Task graph` (exact case, replacing `Execution Progress`).
   - Active count counters: `${count} active` (e.g. `1 active`, `6 active`, `0 active`), replacing `${count} active tasks`.
   - Applied in `app.tsx`, `summary.tsx`, and all associated UI tests/ARIA labels.
2. **Active-First Recursive Ordering:**
   - At every level of the hierarchy (root tasks, child tasks, subagents), unfinished tasks come first, finished tasks below.
   - Stable numeric ID order within active and finished groups (no mixed timestamp arithmetic).
   - A terminal parent with a live descendant remains visible as an active branch (`hasActiveWork(item) === true`).
2. **Folded Finished History:**
   - Finished-only sibling branches are collapsed behind an English bounded control: `See more (N...)`.
   - Honest error reporting: if any hidden task has a failed/faulted outcome or tool error, the control reflects it (`See more (N · M failed)`), never falsely presenting green success.
   - Bounded control toggles to expand finished history and offers `See less` to re-fold.
   - Selection preservation: selecting a retained finished task keeps it inspectable; selection is never cleared due to task termination or branch folding.
3. **Native BB Density & Elimination of Nested Popover:**
   - The BB host disclosure slot already provides `border`, `rounded-lg`, and `bg-surface-raised-solid`.
   - `segment.tsx` removes its redundant `border`, `rounded-md`, `my-1`, and `shadow-sm`, rendering as `w-full bg-transparent overflow-hidden`.
   - Replaces fixed `h-80 max-h-96` with dynamic content-driven height capped at compact `max-h-60` (unselected) and `max-h-72` (selected with inspector).
   - Replaces arbitrary hover shadows on rows and summary with native `hover:bg-state-hover` and `bg-state-active`.
4. **Bounded View Clock (1Hz Tick):**
   - Single 1Hz timer in mounted segment active only when active tasks exist.
   - Stops and cleans up interval on unmount or when all tasks are terminal.
   - Increments elapsed duration for live nodes using native `startedAt`; never invents synthetic start. Terminal duration remains fixed.
5. **Follow Active Prioritization:**
   - Prioritizes genuine `running` work over waiting ancestors or sleeping courier tasks.
   - Uncollapses collapsed ancestor branches when following active.
   - Respects manual scrolling: suspends auto-scroll when user inspects history and provides `Follow active` control.

