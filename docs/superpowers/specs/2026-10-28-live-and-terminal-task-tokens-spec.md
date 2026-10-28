# Architecture Specification: Live and Terminal Task Tokens in Task Graph

**Date:** 2026-10-28  
**Cycle:** 84  
**Component:** `bb-plugin-provider-pi-durable`  
**Governed by:** `/Users/vanya/Projects/AGENTS.md` & `arch-rules.md` (AP-010 – AP-071)  
**Line Budget (AP-019):** Strictly < 200 LOC per file.

---

## 1. Context & Motivation
In Pi Durable, each turn of an agent or assistant interaction executes as an ACID-transactional `GenerationTask` (`pi.generation`).
Currently, the runtime graph UI displays:
- Status icon (`resolveStatusIcon`)
- Label / Breadcrumbs (`resolveItemLabel`)
- Duration (`formatDuration`)

However, users have no visibility into token consumption per generation turn directly in the graph row. The information about token usage (`totalTokens`, `input`, `output`, `reasoning`, `cacheRead`) already exists in:
1. `current.conversation.docs["pi.live"].generation.message.usage` during the live `request` streaming phase.
2. `AssistantEntry` in the conversation log via `task.state.outcome.result.entryId` upon task completion.

The goal is to surface token usage:
1. In `node-row.tsx`: right before the timing (`duration`), formatted compactly (e.g. `1.4k tok · 1.8s` or `450 tok · 820ms`), updating live on the fly during generation where applicable.
2. In `details.tsx`: in the Task Details panel, displaying total tokens and detailed breakdown (input, output, reasoning, cache).

---

## 2. Architecture & Data Contracts

### 2.1. DTO Types (`src/runtime-graph/types.ts`)
```ts
export interface TaskTokensUsage {
	readonly total?: number;
	readonly input?: number;
	readonly output?: number;
	readonly reasoning?: number;
	readonly cacheRead?: number;
}
```
Add `tokens?: TaskTokensUsage` to:
- `RuntimeTaskNode` (for live tasks)
- `RuntimeTaskReceipt` (for completed terminal tasks)

### 2.2. Dedicated Formatter (`src/ui/runtime-graph/token-format.ts`)
- Pure function `formatTokens(tokens?: number): string | null`:
  - `tokens == null || tokens <= 0` -> `null`
  - `< 1000` -> `${tokens} tok`
  - `< 1_000_000` -> `${(tokens / 1000).toFixed(1)}k tok`
  - `>= 1_000_000` -> `${(tokens / 1_000_000).toFixed(1)}M tok`
- Pure function `formatDetailedTokens(tokens?: TaskTokensUsage): string | null`:
  - Returns `1,420 total (1,100 in · 320 out · 250 reasoning)`

### 2.3. Extraction Layer (`src/runner/task-tokens.ts`)
- To prevent `runtime-graph-mapper.ts` from exceeding 200 LOC (AP-019), token extraction is encapsulated in `task-tokens.ts`:
  - `extractLiveTokens(node: TaskGraphNode, current: unknown): TaskTokensUsage | undefined`
  - `extractTerminalTokens(task: TaskRecord<unknown, unknown, unknown>, current: unknown): TaskTokensUsage | undefined`

### 2.4. Presentation Layer (`src/ui/runtime-graph/node-row.tsx`)
- Resolve effective tokens:
  ```ts
  const tokensVal = item.liveNode?.tokens?.total ?? item.receipt?.tokens?.total
    ?? singleChild?.liveNode?.tokens?.total ?? singleChild?.receipt?.tokens?.total;
  const tokens = formatTokens(tokensVal);
  ```
- Render right before duration:
  ```tsx
  {tokens ? (
    <span className="ml-auto text-[10px] text-muted-foreground/80 pr-1.5 flex-shrink-0 font-mono">
      {tokens}
    </span>
  ) : null}
  {duration ? (
    <span className={`${tokens ? "" : "ml-auto "}text-[10px] text-muted-foreground flex-shrink-0`}>
      {duration}
    </span>
  ) : null}
  ```

---

## 3. Invariants & AP Rules
- **AP-010:** Decoupled presentation from backend engine.
- **AP-013:** Monotonic non-negative token counts.
- **AP-019:** All files strictly < 200 LOC.
- **AP-025:** 0 cycles in import graph (Tarjan SCC).
- **AP-026:** Receipts over status (authoritative tokens from `AssistantEntry`).
