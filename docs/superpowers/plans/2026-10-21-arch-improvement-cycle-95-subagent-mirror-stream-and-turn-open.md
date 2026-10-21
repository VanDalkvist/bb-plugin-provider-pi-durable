# Cycle 95: Subagent Mirror Streaming & Turn Lifecycle Synchronization (AP-013, AP-019, AP-026, AP-034)

**Goal:** Eliminate the "No final output was recorded" bug and 120-second BB turn start timeout on native child subthreads by ensuring:
1. `BBChildEventAdapter` propagates child `turn_start` with `conversationId`.
2. `PiThreadSession` buffers early runner events for pending subagent conversations until `registerThread` is called, and flushes them deterministically.
3. `handleTurnStart` in `bridge-router.ts` emits `turn.open` immediately upon accepting a mirror turn (both `running` and `completed` states), satisfying BB's turn watchdog.
4. If a subagent completes before `turn/start` is received, `handleTurnStart` emits the full accumulated assistant output before `turn.boundary` (`status: "completed"`).

## Architecture Context Reference
- **Root Cause Evidence:**
  - BB daemon logs on child threads: `The provider accepted a turn but did not start it within 120s. The request may be stalled; stopping the thread interrupts it.` -> Result: `No final output was recorded.`
  - `BBChildEventAdapter` in `src/runner/bridge/bb-child-event-adapter.ts` suppresses `run_start` and `turn_start` in `case "turn_start": break;`, so `DeltaTranslator` never receives `turn_start` and never emits `turn.open`.
  - Asynchronous gap in `spawnSubthreadInBb` (~2-3s) means early child events arrive when `childThreadId` is undefined, causing them to be permanently dropped.
  - `handleTurnStart` on `mirrorState?.status === "running"` emits only `input.accepted`, never `turn.open`.
  - `handleTurnStart` on `mirrorState?.status === "completed"` emits only `turn.boundary`, omitting assistant text entirely.
- **Affected Files & Line Budgets (AP-019):**
  - `src/runner/bridge/bb-child-event-adapter.ts` (currently 153 lines, limit < 200)
  - `src/host/subagent-mirror.ts` (currently 60 lines, limit < 250)
  - `src/host/session.ts` (currently 235 lines, limit < 250)
  - `src/host/bridge-router.ts` (currently 207 lines, limit < 250)

## Planned Slices (TDD Checkbox Steps)

- [ ] **Task 1: Child `turn_start` Propagation in `BBChildEventAdapter` (Runner)**
  - In `src/runner/bridge/bb-child-event-adapter.ts`:
    - On `case "turn_start":` or `case "run_start":`:
      - Emit `{ type: "turn_start", parentRef: this.parentRef, ...(this.conversationId !== undefined ? { conversationId: this.conversationId } : {}) }`.
  - In `tests/subagent-dual-stream.test.ts` (or new test):
    - Verify `BBChildEventAdapter` emits `turn_start` with `conversationId`.
  - Verify line count of `src/runner/bridge/bb-child-event-adapter.ts` remains < 200 lines.

- [ ] **Task 2: Pending Child Event Buffer in `SubagentMirrorManager` / `PiThreadSession` (Host)**
  - In `src/host/subagent-mirror.ts`:
    - Add `private eventBuffers = new Map<string, RunnerEvent[]>()`.
    - Add `private textBuffers = new Map<string, string>()`.
    - Add `bufferEvent(conversationId: string | number, event: RunnerEvent): void`.
    - Add `drainBufferedEvents(conversationId: string | number): RunnerEvent[]`.
    - Add `recordOutputText(conversationId: string | number, text: string): void`.
    - Add `getOutputText(conversationId: string | number): string`.
  - In `src/host/session.ts`:
    - When `isChildEvent` is true:
      - If `childThreadId` is known: translate and send deltas.
      - If `childThreadId` is NOT known: `this.mirrors.bufferEvent(event.conversationId, event)`.
      - On `text_delta`: accumulate in `this.mirrors.recordOutputText(...)`.
    - In `registerThread(threadId, conversationId)`:
      - Drain buffered events via `this.mirrors.drainBufferedEvents(conversationId)`.
      - Translate and emit them to `threadId` via `getChildTranslator(threadId)`.
  - Verify line count of `src/host/subagent-mirror.ts` and `src/host/session.ts` remain < 250 lines.

- [ ] **Task 3: Turn Lifecycle & `turn.open` in `handleTurnStart` (Host Bridge)**
  - In `src/host/bridge-router.ts`:
    - In `mirrorState?.status === "running"`:
      - Register thread: `session.registerThread(params.threadId, targetConversationId)`.
      - Emit `input.accepted`.
      - Emit `turn.open` immediately so BB's 120s turn watchdog is satisfied.
      - Return `sendResult`.
    - In `mirrorState?.status === "completed"`:
      - Register thread: `session.registerThread(params.threadId, targetConversationId)`.
      - Emit `input.accepted`.
      - Emit `turn.open`.
      - If `session.getMirrorOutputText?.(targetConversationId)` has text:
        - Emit `item.textDelta` with text.
        - Emit `item.textClose` on channel `agentMessage` with text.
      - Emit `turn.boundary` with `status: "completed"`.
      - Consume completed mirror.
      - Return `sendResult`.
  - Verify line count of `src/host/bridge-router.ts` remains < 250 lines.

- [ ] **Task 4: Comprehensive TDD Unit & Integration Tests**
  - Add test suite `tests/subagent-mirror-stream-and-turn-open.test.ts`:
    1. Early child events before `registerThread` are buffered and replayed in order.
    2. `handleTurnStart` on running mirror emits BOTH `input.accepted` and `turn.open`.
    3. `handleTurnStart` on completed mirror emits `turn.open`, assistant text, and `turn.boundary`.
    4. End-to-end simulation: spawning subagent streams full text into child thread and avoids `No final output was recorded`.
  - Run `npm test` (all 261+ tests pass).
  - Run `npx tsc --noEmit` (0 errors).

- [ ] **Task 5: Dual S9 Verification & Version Bump (v0.2.39)**
  - Dual S9 verification gate: S9a Architecture Review + S9b Product Review.
  - Bump `package.json` to `0.2.39`.
  - Build bundles (`npm run build`).
  - Commit.
