# Plan: P1 Session Admission Race Remediation (Slice Plan)

## 1. Problem & Root Cause (Finding [P1] in s9-product-followup.md)
- **Problem**: Concurrent arrival of `thread/start` and `turn/start` (or root and child sessions) on the same session directory launches two runner processes.
- **Root Cause**: In `SessionRegistry.createOrGet`, an await window exists during `await session.start()`. During this window, the session is not yet tracked in `this.sessions`. A second concurrent call enters `createOrGet`, finds no active session, and constructs a second `PiThreadSession`, spawning a second runner process on the same SQLite session directory. The second runner attempts to acquire the lock, causing the first runner to exit with `[SessionStorage] unlock warning ... Lock is not acquired/owned by you` and crash with `Runner exited before becoming ready (code 0, signal null)`, resulting in JSON-RPC error `-32000` and turn interruption.

## 2. Architecture & Design Invariants
- **Single Creator Invariant (AP-034)**: Exactly one runner process may be created per physical session key (`sessionKey`). All concurrent callers for the same session key, same thread ID, or parent thread ID await the in-flight admission.
- **Fail-Fast & Deterministic Error (AP-012, AP-021)**: If the creator fails, all awaiting callers receive the exact deterministic error. In-flight state is cleared in a `finally` block so subsequent retries can proceed cleanly.
- **No Global Scheduler / Independent Concurrency (AP-034)**: Sessions with different keys/thread IDs are completely independent and proceed concurrently without serialization.
- **Alias & Identity Resolution (AP-048)**: Awaiting callers with the same `threadId` reuse the initialized session directly. Awaiting callers with different `threadId`s (child/mirror aliases) attach as shared sessions, registering their conversation and receiving `thread/identity` and `session.reset` deltas.
- **Cleanup Ownership (AP-027)**: If creation is stopped or aborted, only own resources are killed/cleaned up.
- **Line Budgets (AP-019)**: All TS files strictly < 200 lines.

## 3. Implementation Steps (TDD Flow)
1. **Slice Plan (this document)**.
2. **RED Phase**:
   - Create `tests/session-admission-race.test.ts` reproducing:
     - Race 1: Concurrent `createOrGet` for the same `threadId` and `providerThreadId` creates two runners (RED).
     - Race 2: Concurrent root and child `createOrGet` creates two runners (RED).
     - Error Recovery: First creator rejection propagates to waiters and cleans up pending state; retry succeeds (RED).
     - Independent Concurrency: Independent session keys create separate sessions in parallel without blocking.
3. **GREEN Phase**:
   - Implement `src/host/session-admission.ts` (`SessionAdmissionCoordinator`).
   - Integrate into `src/host/session-registry.ts` with optional `sessionFactory` injection.
   - Run tests to confirm GREEN.
4. **Integration & Conformance Verification**:
   - Run full test suite (`npm test`).
   - Re-build plugin (`npm run build`).
   - Verify file line budgets (< 200 lines) and AP rules.
   - Produce artifact `/Users/vanya/.bb/thread-storage/thr_ct3kk9xne6/admission-race-result.md`.
