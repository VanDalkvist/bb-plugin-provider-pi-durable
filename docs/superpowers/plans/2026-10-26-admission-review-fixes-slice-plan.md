# Plan: P1/P2 Session Admission Review Fixes (Slice Plan)

## 1. Problem & Root Cause (Findings from s9-runtime-graph-backend.md)
- **Finding 1 [P1]**: When in-flight session creation is aborted (`admission.aborted = true`), `SessionRegistry` calls `session.kill()` and then `this.admission.release(admission, session)`. This resolves waiting callers with the killed session instead of rejecting them with a typed error.
- **Finding 2 [P1]**: In `SessionAdmissionCoordinator`:
  - A child thread waiting on root creation is not tracked in `byThreadId`, so `stop(childThreadId)` does not cancel its wait; once root creation completes, the canceled child attaches to the session, emits notifications, and registers in `this.sessions`.
  - Conversely, if a child initiates creation before root (`child инициировал создание раньше root`), `byThreadId` maps `childThreadId` to the shared admission; `stop(childThreadId)` sets `admission.aborted = true` and kills the shared runner process, destroying the session for root and all other waiters.
- **Finding 3 [P2]**: In `SessionRegistry.createOrGet`, existing sessions for `threadId` (and candidate parent sessions for `parentThreadId`) are returned/attached without verifying that the requested `sessionKey` matches the session's `sessionKey`. This silently routes requests to the wrong database and violates identity boundaries (AP-039, AP-048).

## 2. Architecture & Design Invariants
- **Fail-Fast & Typed Errors (AP-012, AP-022)**:
  - Aborted admissions reject all waiting callers with a typed error (`SessionCreationAbortedError` with code `SESSION_CREATION_ABORTED`). No killed runner is ever returned.
  - Identity mismatches fail fast with typed `SessionIdentityMismatchError` (code `SESSION_IDENTITY_MISMATCH`) without mutating existing bindings.
- **Explicit Participant & Ownership Discipline (AP-027, AP-034)**:
  - An admission tracks all participating thread IDs independently.
  - Stopping a child participant cancels that child's request without killing the shared root runner process, as long as root or other participants are active.
  - Stopping/disposing the root owner process aborts the entire admission, kills the runner, and rejects all affected participants.
  - Stopping a waiting child cancels its wait immediately, preventing subsequent attachment or notification emission.
- **Single Writer & Race Recovery (AP-034, AP-013)**:
  - Retain the proven single runner process invariant per physical `sessionKey` (validated in `s9-admission-race-retest.md`).
  - Creation failure or abort cleans up in-flight state completely, allowing immediate clean retries without hanging promises.
- **Line Budgets & File Boundaries (AP-019)**:
  - All modified and new TS files strictly < 200 lines.
  - Extract typed error definitions into a dedicated helper (`src/host/session-errors.ts`).

## 3. TDD Implementation Phases

### Phase 1: RED (Failing Tests)
Create `tests/session-admission-lifecycle.test.ts` covering:
1. Aborted admission rejects waiting Promise with typed error; does NOT resolve with killed runner.
2. Stop child waiter cancels wait, does not attach later, does not affect root or other child waiters.
3. Child initiates creation before root; stop child creator does NOT kill shared root; root receives live session, child is rejected.
4. Dispose / stopAll / abort of creating root rejects all affected requests with safe typed error and kills runner, without returning killed runner.
5. Creator rejection and retry without hanging promise.
6. Same threadId returns existing only when sessionKey matches; mismatch throws typed `SessionIdentityMismatchError` and does not mutate binding.
7. Child requesting parentThreadId with mismatched sessionKey throws typed `SessionIdentityMismatchError` and does not mutate parent.

### Phase 2: GREEN (Implementation)
1. Create `src/host/session-errors.ts` (< 50 lines) with:
   - `SessionCreationAbortedError` (code: `"SESSION_CREATION_ABORTED"`)
   - `SessionIdentityMismatchError` (code: `"SESSION_IDENTITY_MISMATCH"`)
   - `SessionOwnerConflictError` (code: `"SESSION_OWNER_CONFLICT"`)
2. Update `src/host/session-admission.ts` (< 200 lines):
   - Refactor `InFlightAdmission` to track individual participants (`AdmissionParticipant`).
   - Implement participant-level abort in `abort(threadId)`:
     - If child participant aborted: cancel child, do not kill shared root if other participants exist.
     - If root participant aborted: abort entire admission, kill runner, reject all participants.
   - In `reject(admission, err)`: reject all participants, cleanup mappings.
   - In `release(admission, session)`: resolve all active non-aborted participants, reject aborted participants.
   - Add `dispose()` alias to `abortAll()`.
3. Update `src/host/session-registry.ts` (< 200 lines):
   - Validate `sessionKey` matching in `createOrGet` for `existing` and `parentThreadId` candidate; throw `SessionIdentityMismatchError` on mismatch without mutating `this.sessions`.
   - On `admission.aborted` (or creator aborted): call `this.admission.reject(...)`, do NOT call `release(...)`.
   - If creator child was aborted but admission succeeded for root: do not register child, throw `SessionCreationAbortedError` for child, but resolve root.
   - If waiter was aborted: reject waiter, do not attach or emit notifications.

### Phase 3: Verification & Review
1. Run focused tests: `node --test tests/session-admission-lifecycle.test.ts` and `node --test tests/session-admission-race.test.ts`.
2. Run TypeScript check: `npx tsc --noEmit`.
3. Verify file line counts (< 200 lines) per AP-019.
4. Prepare result artifact at `/Users/vanya/.bb/thread-storage/thr_ct3kk9xne6/admission-review-fixes-result.md`.
