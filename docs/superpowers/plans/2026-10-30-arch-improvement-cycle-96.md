# Arch Improvement Plan: Cycle 96 — Deterministic Subagent Mirror Attachment

- **Cycle**: 96
- **Date**: 2026-10-30
- **Goal**: Cleanly and deterministically resolve native subagent conversation binding during BB thread creation, eliminating race conditions without empty catches, redundant fallbacks, or heuristic guessing.

## Context & Architecture Map
- **BB Server Core Contract**:
  - `threads.startup_context` is guaranteed to exist at `thread/start` time, storing `{ request: { input: [{ text: "..." }] } }`.
  - `threads.startup_context` is only cleared when a thread transitions to `idle` (after first turn completes).
  - During initial subagent spawn, `subthread-spawner.ts` invokes `bb thread spawn --prompt args.task`.
  - In `SubagentMirrorManager`, the task is tracked in `pendingByTask` with exact text from `tool_execution_update` (`details.task`).
- **Defects Identified**:
  - F1: Double SQLite query with empty catch hiding database errors.
  - F2: Superfluous fallback to `events` table with empty catch.
  - F3: 4-level fallback cascade and heuristic `getUnboundSubagentConversationId` guessing conversations.

## Fix Slices

### Slice 1: Clean, Single-Query Database Context Extraction
- File: `src/host/subthread-spawner.ts`
- Remove double `SELECT` query and empty `catch` blocks.
- Execute one canonical query: `SELECT project_id, environment_id, parent_thread_id, startup_context FROM threads WHERE id = ?`.
- Parse `startup_context` strictly against BB schema:
  - Extract text chunks from `request.input`.
  - Log structured warning on JSON parse failure instead of swallowing silently.
- Drop unused `events` table query.
- Keep file LOC strictly < 200 per AP-019.

### Slice 2: Deterministic Target Conversation Resolution in SessionRegistry
- Files: `src/host/session-registry.ts`, `src/host/subagent-mirror.ts`, `src/host/session.ts`, `src/host/session-port.ts`, `src/host/session-subagent-handler.ts`
- Remove `getUnboundSubagentConversationId` and prefix substring guessing.
- `findConversationForTask`: strict trimmed exact match (`pendingByTask.get(task.trim())`).
- `SessionRegistry.attachShared`:
  - `targetConvId = nativeChild.conversationId ?? (text ? session.findSubagentConversationForTask(text) : undefined) ?? session.getConversationIdForThread(threadId);`
  - Exactly 3 well-defined causal sources:
    1. Composite providerThreadId (if explicit native child)
    2. Prompt matching task in pendingByTask (from startup_context in bb.db)
    3. Memory binding map (if CLI returned and registered thread before thread/start)
- If `parentThreadId` is present and none of the 3 resolved: throw explicit error with full diagnostics (fail-closed).
- Keep all file LOC strictly within limits.

### Slice 3: Standardize Test Fixtures & TDD Verification
- Files: `tests/host-subthread-shared-session.test.ts`, `tests/fixtures/mirror.ts`
- Align test SQLite schema for `threads` with real BB Core schema (`startup_context` included).
- Test Suite:
  1. Unit test: thread/start arriving before CLI return resolves via `startup_context` prompt.
  2. Negative test: mismatched or missing prompt throws explicit error (fail-closed).
  3. Regression test: existing parent and DB parent resolution.
- Verify 100% pass on contracts and full test suite.

### Slice 4: Build, Release & BB Runtime Activation
- Bump version to `0.3.27` in `package.json` and `package-lock.json`.
- Compile bundles via `npm run build`.
- Update `CHANGELOG.md` and `docs/arch-improvement/ledger.md`.
- Commit, tag `v0.3.27`, push to `origin`.
- Update plugin in BB: `bb plugin update provider-pi-durable`.
- Verify live BB subagent execution.
