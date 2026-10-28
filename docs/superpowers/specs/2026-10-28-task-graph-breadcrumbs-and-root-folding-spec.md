# Task Graph Breadcrumbs & Root-Only History Folding Spec

**Date:** 2026-10-28  
**Cycle:** 82  
**Component:** `bb-plugin-provider-pi-durable / src/ui/runtime-graph`

## 1. Context & Problem Statement

In `bb-plugin-provider-pi-durable`, every LLM model turn is executed as an ACID-durable `pi.generation` task in `@earendil-works/pi-durable`. When the model sequentially calls a tool (e.g. `read` or `bash`), the `pi.generation` owns exactly one child `pi.tool` task.

Previously, the Task Graph UI exhibited severe UX defects:
1. **Multi-line expansion for single tool calls:** A generation with a single child tool call occupied 2 to 3 lines: the generation header, a chevron, the child row, and an unnecessary `See more / See less` button.
2. **Global ID leakage in folding:** `tree-preview.ts` computed a global `previewFinishedIds` set (capped at 5 across the *entire graph*). Because the total count across 50+ turns exceeded 5, child branches with only 1 child were considered "hidden" and rendered a parasitic `See more (1 completed)` button inside the branch.
3. **Open-by-default multi-child nodes:** Nodes with multiple children were expanded by default because `collapsedTaskIds` started as an empty set.

## 2. Target Design

### 2.1 Single-Child Breadcrumbs (1-Line Flattening)
- When any task node has **EXACTLY 1 child** (e.g. `pi.generation` owning a single `pi.tool`):
  - It renders on **EXACTLY ONE line**.
  - No collapse/expand chevron (an indent spacer `w-4 h-4` is rendered instead).
  - The label displays breadcrumbs:
    ```text
    ✓ pi.generation #67 › read: src/foo.ts                     3.6s
    ```
  - The status icon reflects the active work or error state (e.g. running spinner if active, red error if failed/toolError, green check if completed).
  - Click interaction:
    - Clicking the row or the child segment selects the child task (the actual tool operation).
    - Clicking the parent segment selects the parent task (`pi.generation`).
    - Duration reflects the overall step duration.

### 2.2 Collapsed-by-Default Multi-Child Nodes
- When a task node has **$\ge 2$ children**:
  - By default, finished nodes are **COLLAPSED** (`ChevronRight`), occupying exactly 1 line:
    ```text
    › ✓ pi.generation #42 (3 tasks)                          2.1s
    ```
  - Clicking the chevron toggles expansion to show the child rows.
  - Exception: If the task or its children are actively running (`hasActiveWork(item)` is true), it remains expanded while active so the user sees live progress. Once complete, it collapses.

### 2.3 Root-Only History Folding
- `See more / See less` is strictly forbidden inside child branches and generation subtrees.
- Folding applies **ONLY at the root level** of the graph (top-level turns):
  - Only the first 5 root-level items (active tasks plus top finished tasks) are shown initially.
  - If there are $> 5$ root items, a clean toggle button is placed **at the bottom of the root list**:
    ```text
    ∨ See more (N completed)
    ```
  - Clicking it expands the root list downwards (toggling to `∧ See less`), allowing full scrolling of the complete history.

## 3. Invariants & Rules
- **AP-019 (Line Budgets):** All `.ts` and `.tsx` files strictly < 200 lines (soft limit 150, hard limit 250).
- **AP-013 & AP-028 (Deterministic Testing & TDD):** 100% pass on all backend and UI tests.
- **One Commit = One Patch Bump:** `0.3.12` → `0.3.13`.
