# Arch Improvement Cycle 97 — Subagent Mirror Correlation & Independent Child Threads Plan

## Goal
Fix regressions from earlier subagent changes where ordinary Beyond Boundaries child threads were forcibly captured and failed closed, eliminate parent transcript corruption from leaked child turn lifecycles, and ensure native Pi subagent mirrors deterministically attach to the parent's single runner (`session.sqlite`) without task collisions.

## Root Cause Analysis & Audit Findings
1. **Conflation of `parent_thread_id` with Native Mirror (`src/host/session-registry.ts`):**
   - In `createOrGet`: line 76-105 assumed ANY thread with `parent_thread_id` must attach to the parent session via `attachShared`. When `targetConvId` failed to resolve, it threw `Cannot resolve native child conversation for thread <childId> under parent <parentThreadId>`.
   - On cold start: line 116 `if (nativeChild.isNative || parentThreadId)` forced booting the parent session instead of creating an independent child session.
   - **Fix:** `attachShared` is invoked ONLY when `targetConvId` actually resolves (explicit binding, composite providerThreadId, or valid envelope / pending subagent match). If unresolved, `createOrGet` falls through to spawn an independent session for `threadId`. Line 116 strictly checks `if (nativeChild.isNative)`.
2. **Child Turn Lifecycle Leaking to Parent Timeline (`src/host/session-subagent-handler.ts`):**
   - In `handleEvent`: line 176 `return isChildEvent && (!event.parentRef || event.type === "agent_end")` returned `false` for child `turn_start` (because `parentRef` was set). This caused parent `DeltaTranslator` to emit an unparented `turn.open` on the parent thread. When child finished, child `agent_end` returned `true` (dropped), leaving the parent turn permanently open and corrupting the timeline.
   - **Fix:** Child turn lifecycle events (`turn_start`, `agent_start`, `turn_end`, `agent_end`) must always be dropped from parent translation (`shouldDropFromParent = true`). Only content deltas belonging to parent delegation cards stream under the parent.
3. **Subagent Task Collisions (`src/host/subagent-mirror.ts`):**
   - `pendingByTask` was a single `Map<string, string>`. Identical prompt texts collided.
   - **Fix:** Use typed envelope carrying canonical `sessionKey`, `parentThreadId`, and `conversationId`, plus FIFO queue per task for backwards compatibility.
4. **Lifecycle Ownership (`src/host/subthread-spawner.ts`):**
   - In `buildSpawnArgs`: pass `--lifecycle-owner-thread` alongside `--parent-thread` so BB links lifecycle ownership.
5. **Reserved Protocol Envelope Security (`src/shared/subagent-envelope.ts`):**
   - Format: `[bb:pi-subagent-mirror:v1 session=<sessionKey> parent=<parentThreadId> conv=<conversationId>]\n<actualTask>`
   - Malformed or unsupported version envelopes fail typed immediately (`InvalidSubagentMirrorEnvelopeError`) and NEVER reach the LLM. Ordinary non-reserved text remains ordinary.

## Implementation Slices & TDD Tasks

### Slice 1: Typed Envelope Parser, Formatter & Errors (`src/shared/subagent-envelope.ts`)
- [x] Unit test `tests/subagent-envelope.test.ts`:
  - Format with `sessionKey`, `parentThreadId`, `conversationId`, and `task`.
  - Parse valid envelope returning `{ isMirror: true, sessionKey, parentThreadId, conversationId, task }`.
  - Non-reserved prompt returns `{ isMirror: false, task }`.
  - Malformed or unsupported reserved envelope (`[bb:pi-subagent-mirror:...`) throws `InvalidSubagentMirrorEnvelopeError`.
  - Root conversation (`conv=1`) throws error.
  - Strip envelope returns clean task text.
- [x] Implement in `src/shared/subagent-envelope.ts` (< 100 LOC).

### Slice 2: Subthread Spawner with Versioned Envelope & Lifecycle Owner (`src/host/subthread-spawner.ts`)
- [ ] Test in `tests/host-subthread-spawner.test.ts`:
  - `buildSpawnArgs` adds `--lifecycle-owner-thread <parentThreadId>`.
  - `buildSpawnArgs` formats `--prompt` with `formatSubagentMirrorPrompt(sessionKey, parentThreadId, conversationId, task)`.
- [ ] Implement changes in `src/host/subthread-spawner.ts` (< 200 LOC target).

### Slice 3: Collision-Free Mirror Tracking (`src/host/subagent-mirror.ts`)
- [ ] Test in `tests/subagent-mirror-state.test.ts`:
  - Concurrent subagents with identical tasks are tracked cleanly by `conversationId` and FIFO task queue.
  - Consuming completed mirror removes from FIFO queue without corrupting sibling entries.
- [ ] Implement FIFO `pendingByTask` (`Map<string, string[]>`) in `src/host/subagent-mirror.ts` (< 200 LOC target).

### Slice 4: SessionRegistry Decoupling & Independent Child Execution (`src/host/session-registry.ts`)
- [ ] Test in `tests/host-subthread-shared-session.test.ts`:
  - Ordinary child thread with `parentThreadId` (from params or `bb.db`) creates an independent session (no capture, no crash).
  - Child thread with mirror envelope attaches to exact parent session and conversation.
  - Parent/sessionKey mismatch or unknown conversation throws typed error before mutation.
  - Remove incorrect invariant test asserting fail-closed on unmatched task.
- [ ] Implement:
  - In `createOrGet`: resolve `targetConvId` via explicit binding, composite ID, or valid mirror envelope / FIFO task queue.
  - If NOT resolved as mirror: fall through to create independent session for `threadId`.
  - Remove `|| parentThreadId` from cold start branch.
  - Line budgets: `src/host/session-registry.ts` (< 250 LOC hard budget).

### Slice 5: Child Turn Lifecycle Isolation & Parent Transcript Cleanliness (`src/host/session-subagent-handler.ts`)
- [ ] Test in `tests/subagent-dual-stream.test.ts` or `tests/subagent-timeline-ordering.test.ts`:
  - Child `turn_start` emits `turn.open` to child thread, but is DROPPED from parent timeline (`shouldDropFromParent = true`).
  - Child `agent_end` emits boundary to child thread, but is DROPPED from parent timeline.
  - Only delegation summary card remains on parent.
- [ ] Implement in `src/host/session-subagent-handler.ts` (< 200 LOC target).

### Slice 6: Verification & Delivery
- [ ] Run full test suite (`npm test`).
- [ ] Run contract tests (`npm run test:contracts`).
- [ ] Verify line budgets (< 200 LOC target, 250 hard limit).
- [ ] Check acyclic import graph (`node scripts/verify-import-graph.mjs`).
- [ ] Record findings and verification in `docs/arch-improvement/ledger.md`.
