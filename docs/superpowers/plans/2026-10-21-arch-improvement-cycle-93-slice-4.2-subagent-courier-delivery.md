# Architecture Plan - Cycle 93 Slice 4.2: Subagent Reporter + Courier Delivery Architecture

- **Cycle**: 93
- **Slice**: 4.2
- **Goal**: Implement reliable Subagent Reporter + Courier delivery in `bb-plugin-provider-pi-durable`. Guarantees that when background subagents complete, their reports are not lost in isolation but are atomically gathered, debounced (50ms), and delivered into the parent conversation via `parent.submit({ whenBusy: "followUp" })` with idempotent `requestId`.
- **Primary Source / Reference**:
  - `docs/arch-improvement/cycle-93/track-4-subagents-persistence.md`
  - Reference implementation: `/tmp/diffuzmetall-adapter/src/protocol/subagents/` (`delivery.ts`, `documents.ts`, `tasks.ts`)
- **Applicable AP Gates**:
  - AP-010 (Thin Bridge / Clean Architecture)
  - AP-012 (Explicit FSM & Checkpoints: `deliver` -> `report`, `gather` -> `next` -> `send` -> `hold`)
  - AP-013 (Event Pipeline Determinism)
  - AP-019 (File size limits: strictly < 200 lines for all files in `src/runner/`)
  - AP-026 (ACID Persistence in SQLite via Pi Durable `defineDoc`)
  - AP-028 (TDD: deterministic unit & integration tests)
  - AP-029 (Zero Type Casts / strict types)
  - AP-034 (50ms Gather Debounce & Concurrency Discipline)

---

## Tasks Breakdown

### Task 1: Create `src/runner/subagent-docs.ts` (AP-019 < 200 lines)
- Define `SubagentRecord`, `PendingSubagentReport`, `SubagentBatchPayload`, `DeliveryHoldState`.
- Define and export `SubagentsDoc = defineDoc({ kind: "bb.subagents", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ agents: {} }) })`.
- Line budget: ~40 lines (< 200).

### Task 2: Create `src/runner/subagent-delivery.ts` (AP-019 < 200 lines)
- Define and export:
  - `BACKGROUND = { ownership: { kind: "conversation" }, background: true } as const`
  - `Anchor` task (`bb.subagent-anchor`).
  - `reporterFor(courier: CourierTask, admit?: SubagentAdmission)`:
    * `phase: "deliver"`: awaits child completion via `submission.wait(context)`, extracts text from `AssistantEntry`, saves report into `SubagentsDoc.agents[key]`, checkpoints to `phase: "report"`.
    * `phase: "report"`: pushes report into `SubagentsDoc.outbox`, ensures `state.courier` is created, finishes with `terminal:completed`.
  - `courierFor(admit?: Admission)`:
    * `phase: "gather"`: sleeps 50ms (`runtime.sleep(runtime.now() + 50, context)`), checkpoints to `phase: "next"`.
    * `phase: "next"`: packs `outbox` into `sending` with deterministic `requestId: "subagent-batch:${task.id}:${batch}"`, checkpoints to `phase: "send"`.
    * `phase: "send"`: calls `parent.submit({ type: "input", content, whenBusy: "followUp", requestId })`, waits on `submission.wait(context)`. Deletes `state.sending` on `done` and loops back to `next`.
    * `phase: "hold"`: watches `SubagentsDoc` for release of hold state.
- Line budget: ~150 lines (< 200).

### Task 3: Register Subagent Tasks in `src/runner/harness-setup.ts` & update `src/runner/subagent.ts`
- In `src/runner/harness-setup.ts`:
  - Install `Anchor`, default `Courier`, and default `Reporter` into `Registry` via `createCodingRegistry`.
- In `src/runner/subagent.ts`:
  - When tool executes:
    * In transaction, record subagent in `SubagentsDoc.agents[key]`.
    * For `isBackground = true`: create `Reporter` task (`tx.createTask(reporter, input, BACKGROUND)`).
    * Return immediate acknowledgment: `Subagent spawned in background (conversation ${child}). The task is running independently and will report upon completion.`.
    * For `isBackground = false`: submit directly to child conversation and wait for answer.
- Line budget: `subagent.ts` ~130 lines (< 200).

### Task 4: Add TDD Test Suite `tests/subagent-courier-delivery.test.ts`
- Test 1: Background subagent creates `Reporter` task and sets up `SubagentsDoc`.
- Test 2: Reporter extracts `AssistantEntry` text and places report in `SubagentsDoc.outbox`.
- Test 3: Courier gathers multiple reports within 50ms window and submits a combined batch with `whenBusy: "followUp"`.
- Test 4: Courier idempotency: repeated send with same `requestId` does not duplicate turns.
- Test 5: End-to-end integration: background subagent run finishes and parent inbox receives the batch report.

### Task 5: Verification & Gate S9
- Verify `wc -l` on all touched files (< 200 lines).
- Run `npx tsc --noEmit` (0 errors).
- Run `npm test` (all 247+ tests green).
