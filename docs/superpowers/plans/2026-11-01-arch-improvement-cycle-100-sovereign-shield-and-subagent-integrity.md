# Cycle 100: Sovereign Shield & Subagent Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all 4 P0 vulnerabilities (courier deadlock, zombie subagents, SQLite WAL corruption, unvalidated SIGTERM), 9 P1 defects (silent spawn drops, unhandled policy errors, stdin/event races, anchor mismatch, recursion depth, atomic bindings, token metrics), and 3 P2 architectural issues (GoF Strategy activation, leaky facade, and layer boundary leaks) with zero abstraction leaks at every step.

**Architecture:** Ports & Adapters with an automated layer boundary firewall (`scripts/verify-layer-boundaries.mjs`). `src/contracts/` and `src/shared/` contain pure schemas/errors; `src/runner/` is the sovereign core with 0 imports from `src/host/`; `src/host/` is the Beyond Boundaries plugin with 0 direct imports from `src/runner/` (interacting strictly via POSIX stdio, JSON-RPC wire commands, and shared contracts).

**Tech Stack:** TypeScript (strict), Node.js (POSIX stdio, SQLite WAL), Vitest, Zod, Pi Durable FSM (`@earendil-works/pi-durable`), Beyond Boundaries Plugin SDK.

---

## File Structure & Layer Boundary Map

- **Contracts & Shared (`src/contracts/`, `src/shared/`, `src/runtime-graph/`):**
  - `src/runtime-graph/scope.ts`: Pure conversation filtering functions (moved out of `src/runner/`). Zero runner/host dependencies.
  - `src/shared/errors.ts`: Canonical domain/storage error classes (`DurableStorageError`).
  - `src/contracts/`: Pure Zod DTOs, wire message schemas.
- **Sovereign Kernel (`src/runner/`):**
  - `src/runner/engine.ts`: In-process facade with private `#instance` (encapsulated GoF Facade).
  - `src/runner/subagent-courier.ts`: Outbox reporter courier with auto-clearing `deliveryHold` and timeout.
  - `src/runner/runtime-controller.ts`: Controller with cascading abort for all background subagent conversations.
  - `src/runner/subagent.ts`: Fail-fast model resolution error handling, recursion `depth` guard, and accurate conversation indexing.
  - `src/runner/session-storage.ts`: Safe PID locking with process start time validation.
  - `src/runner/index.ts`: Serialized stdin JSONL command queue.
  - `src/runner/runtime-loader.ts` & `src/runner/plugins/`: Wired `DurablePluginRegistry` (GoF Strategy).
- **Host Integration (`src/host/`):**
  - `src/host/runtime-graph-delta.ts`: Imports scope strictly from `src/runtime-graph/scope.ts`.
  - `src/host/paths.ts`: Imports errors strictly from `src/shared/errors.ts`.
  - `src/host/diagnostics.ts`: Decoupled from `src/runner/extension-bridge.ts`.
  - `src/host/runner-process.ts`: Serialized FIFO queue for `onEvent` dispatch.
  - `src/host/durable-binding-store.ts`: Atomic write-and-rename for `adapter-bindings.json`.
  - `src/host/thread-fork.ts`: Safe SQLite backup/checkpointing without copying `.sqlite-shm`.
  - `src/host/session-subagent-handler.ts`: Monitored child thread spawning with error telemetry.
- **UI Presentation (`src/ui/`):**
  - `src/ui/runtime-graph/tree-builder.ts`: Non-regressive token delta calculation.
- **Tooling & CI:**
  - `scripts/verify-layer-boundaries.mjs`: Automated linter forbidding cross-layer boundary violations.

---

### Task 1: Layer Boundary Firewall & Leaky Facade Remediation (AP-010, AP-020, AP-025)

**Boundary:** Ports & Adapters Architecture Guard  
**Files:**
- Create: `src/runtime-graph/scope.ts`
- Create: `src/shared/errors.ts`
- Create: `scripts/verify-layer-boundaries.mjs`
- Modify: `src/runner/runtime-graph-scope.ts` (re-export or forward to `src/runtime-graph/scope.ts`)
- Modify: `src/host/runtime-graph-delta.ts:1-10`
- Modify: `src/host/paths.ts:1-10`
- Modify: `src/host/diagnostics.ts:1-25`
- Modify: `src/runner/engine.ts:15-30`
- Modify: `package.json` (add boundary check to test script)
- Test: `tests/layer-boundary-firewall.test.ts`

- [ ] **Step 1: Write boundary verification script and test**
Create `scripts/verify-layer-boundaries.mjs` scanning `src/` to ensure:
1. `src/host/` has 0 imports matching `from ['"].*runner/.*['"]`.
2. `src/runner/` has 0 imports matching `from ['"].*host/.*['"]`.
3. `src/contracts/` has 0 imports from `runner` or `host`.
Create `tests/layer-boundary-firewall.test.ts` verifying the boundary check passes.

- [ ] **Step 2: Run test to observe failure**
Run: `node scripts/verify-layer-boundaries.mjs`
Expected: FAIL reporting leaks in `runtime-graph-delta.ts`, `paths.ts`, and `diagnostics.ts`.

- [ ] **Step 3: Relocate shared logic and encapsulate `DurableEngine`**
1. Move `filterSnapshotForConversation` to `src/runtime-graph/scope.ts`.
2. Extract `DurableStorageError` to `src/shared/errors.ts`.
3. Update `src/host/runtime-graph-delta.ts` to import from `../runtime-graph/scope.ts`.
4. Update `src/host/paths.ts` to import from `../shared/errors.ts`.
5. Update `src/host/diagnostics.ts` to remove direct runner imports.
6. In `src/runner/engine.ts`, convert `public readonly instance` to `private readonly #instance` and expose necessary accessors (`getSnapshot()`, `getStatus()`). Update `tests/durable-engine-facade.test.ts` to use facade accessors.

- [ ] **Step 4: Verify layer boundary firewall passes**
Run: `node scripts/verify-layer-boundaries.mjs && npm test tests/layer-boundary-firewall.test.ts tests/durable-engine-facade.test.ts`
Expected: PASS (0 boundary leaks, facade cleanly encapsulated).

- [ ] **Step 5: Commit**
```bash
git add src/ scripts/ tests/ package.json
git commit -m "fix(arch): eliminate host-runner boundary leaks and encapsulate DurableEngine facade"
```

---

### Task 2: P0 Subagent Courier Deadlock Elimination (AP-012, AP-023, AP-047)

**Boundary:** Runner Domain / Subagent Delivery Engine  
**Files:**
- Modify: `src/runner/subagent-courier.ts:60-110`
- Modify: `src/runner/subagent-delivery.ts`
- Test: `tests/subagent-courier-lifecycle.test.ts`

- [ ] **Step 1: Write failing test exposing permanent courier hold deadlock**
In `tests/subagent-courier-lifecycle.test.ts`, simulate a courier sending an outbox report where the parent turn is busy/interrupted (`settled.status = "interrupted"` or non-done). Verify that in the current code, `deliveryHold` is never cleared and the courier permanently blocks subsequent outbox deliveries.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/subagent-courier-lifecycle.test.ts`
Expected: FAIL with courier stuck in `hold` phase and second task delivery blocked.

- [ ] **Step 3: Implement auto-recovery, admission hook, and timeout in courier**
1. In `src/runner/subagent-courier.ts`, add a hold timeout (e.g. 10s watchdog) after which `deliveryHold` is reset with a logged warning, allowing retry.
2. Provide an explicit `clearDeliveryHold(runtime, context)` function exported and invoked whenever parent conversation starts a new turn or admits child reports.
3. If parent submission fails with a transient error, transition to a backoff retry instead of indefinite deadlock.

- [ ] **Step 4: Verify test passes**
Run: `npx vitest run tests/subagent-courier-lifecycle.test.ts`
Expected: PASS (courier recovers from uncertain delivery and delivers queued outbox items).

- [ ] **Step 5: Verify line budget (AP-019)**
Check `wc -l src/runner/subagent-courier.ts` (< 200 LOC).

- [ ] **Step 6: Commit**
```bash
git add src/runner/subagent-courier.ts tests/subagent-courier-lifecycle.test.ts
git commit -m "fix(subagent): eliminate permanent courier hold deadlock and add delivery retry watchdog"
```

---

### Task 3: P0 Cascading Abort of Zombie Subagents (AP-047)

**Boundary:** Runner Domain / FSM Controller  
**Files:**
- Modify: `src/runner/runtime-controller.ts:140-165`
- Modify: `src/runner/session-commands.ts:70-95`
- Test: `tests/subagent-cascading-abort.test.ts`

- [ ] **Step 1: Write failing test for zombie subagent quota leakage on abort**
Create `tests/subagent-cascading-abort.test.ts`: Spawn a root conversation and two background subagents attached to Anchor tasks. Call `controller.abort()`. Assert that child conversations are aborted and their active tool runs are cancelled. Currently, only root is aborted.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/subagent-cascading-abort.test.ts`
Expected: FAIL (child conversations remain active after root abort).

- [ ] **Step 3: Implement cascading abort in runtime controller**
1. In `src/runner/runtime-controller.ts`, enhance `abort()` to:
   - Call `current.abort()`.
   - Read `SubagentsDoc` or query active conversations from runtime storage.
   - For every child conversation registered in `SubagentsDoc` whose status is active/running, invoke `childConversation.abort()`.
2. In `src/runner/session-commands.ts`, ensure command `"abort"` with no `conversationId` or root `conversationId` triggers the cascading abort across all subagents.

- [ ] **Step 4: Verify test passes**
Run: `npx vitest run tests/subagent-cascading-abort.test.ts`
Expected: PASS (all background subagents receive abort signal and cease operations).

- [ ] **Step 5: Verify line budget (AP-019)**
Check `wc -l src/runner/runtime-controller.ts src/runner/session-commands.ts` (< 200 LOC each).

- [ ] **Step 6: Commit**
```bash
git add src/runner/runtime-controller.ts src/runner/session-commands.ts tests/subagent-cascading-abort.test.ts
git commit -m "fix(subagent): implement cascading abort to terminate background zombie subagents"
```

---

### Task 4: P0 Safe SQLite WAL Fork & Cascade Rollback (AP-013, AP-034)

**Boundary:** Host Infrastructure / Database Storage  
**Files:**
- Modify: `src/host/thread-fork.ts:25-90`
- Test: `tests/thread-fork-wal-integrity.test.ts`

- [ ] **Step 1: Write failing test for SQLite WAL torn pages and .sqlite-shm copying**
In `tests/thread-fork-wal-integrity.test.ts`, simulate forking an active SQLite database with uncheckpointed WAL entries. Verify that raw file copying produces torn WAL or lock conflicts, and verify checkpoint rollback corrupts table relationships if only `entries` is pruned.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/thread-fork-wal-integrity.test.ts`
Expected: FAIL (WAL state inconsistent or shared-memory file copied).

- [ ] **Step 3: Implement safe SQLite fork via checkpoint/VACUUM and cascaded pruning**
1. In `src/host/thread-fork.ts`:
   - Open source database with `DatabaseSync` in read-only mode and execute `PRAGMA wal_checkpoint(TRUNCATE)` or use SQLite `VACUUM INTO 'target.sqlite'`.
   - Explicitly DO NOT copy `session.sqlite-shm`.
   - When pruning at `checkpointId`, perform clean relational cascade: remove orphaned `tasks`, `submissions`, and roll back document revisions beyond the checkpoint transaction.

- [ ] **Step 4: Verify test passes**
Run: `npx vitest run tests/thread-fork-wal-integrity.test.ts`
Expected: PASS (forked SQLite database is pristine, opens cleanly without WAL torn pages).

- [ ] **Step 5: Verify line budget (AP-019)**
Check `wc -l src/host/thread-fork.ts` (< 200 LOC).

- [ ] **Step 6: Commit**
```bash
git add src/host/thread-fork.ts tests/thread-fork-wal-integrity.test.ts
git commit -m "fix(storage): implement safe SQLite WAL fork and cascade checkpoint rollback"
```

---

### Task 5: P0 OS Process Safety: Stale PID Verification Before SIGTERM (AP-013, AP-047)

**Boundary:** Runner Infrastructure / Process Storage  
**Files:**
- Modify: `src/runner/session-storage.ts:80-120`
- Test: `tests/session-storage-pid-safety.test.ts`

- [ ] **Step 1: Write failing test for unvalidated PID termination**
In `tests/session-storage-pid-safety.test.ts`, simulate a lock file where `owner.pid` is occupied by an unrelated dummy process with a different creation time or command line. Assert that `acquireSessionLock` does NOT send `SIGTERM` to this unrelated process.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/session-storage-pid-safety.test.ts`
Expected: FAIL (SIGTERM attempted against foreign PID).

- [ ] **Step 3: Implement process validation helper before signal dispatch**
1. In `src/runner/session-storage.ts`, add a helper `isSameDurableRunnerProcess(pid: number, expectedStartedAt?: number): boolean`.
2. Inspect OS process details (`process.kill(pid, 0)` for existence, and verify process identity or start time via `ps`). If identity cannot be verified or does not match, throw `DurableStorageLockError` instead of blindly killing the process.

- [ ] **Step 4: Verify test passes**
Run: `npx vitest run tests/session-storage-pid-safety.test.ts`
Expected: PASS (unrelated PIDs are protected from spurious SIGTERM).

- [ ] **Step 5: Verify line budget (AP-019)**
Check `wc -l src/runner/session-storage.ts` (< 200 LOC).

- [ ] **Step 6: Commit**
```bash
git add src/runner/session-storage.ts tests/session-storage-pid-safety.test.ts
git commit -m "fix(storage): validate process identity before sending SIGTERM to stale PIDs"
```

---

### Task 6: P1 Subagent Model Policy Fail-Fast & Recursion Depth Guard (AP-012, AP-022, AP-048)

**Boundary:** Runner Domain / Subagent Extension  
**Files:**
- Modify: `src/runner/subagent.ts:40-90`
- Modify: `src/runner/subagent-role.ts`
- Test: `tests/subagent-policy-error-handling.test.ts`

- [ ] **Step 1: Write failing test for unhandled policy error and fork bomb recursion**
In `tests/subagent-policy-error-handling.test.ts`:
1. Invoke `subagent.execute` with an unavailable model: assert it returns `{ isError: true, content: [...] }` with actionable message rather than throwing unhandled rejection.
2. Invoke `subagent.execute` from within a subagent that has reached `depth >= 2`: assert it returns an error rejecting nested subagent recursion.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/subagent-policy-error-handling.test.ts`
Expected: FAIL (unhandled exception thrown, recursion permitted).

- [ ] **Step 3: Implement try/catch policy resolver and depth guard**
1. In `src/runner/subagent.ts`, wrap `resolveSubagentModelConfiguration` in a `try/catch` block. Catch `SubagentPolicyInvalidError` and `SubagentModelUnavailableError`, returning a cleanly formatted error tool result.
2. Introduce `depth: number` in the subagent context/role. Increment depth on child spawn. If `currentDepth >= 2`, return an error indicating maximum subagent nesting depth reached.

- [ ] **Step 4: Verify test passes**
Run: `npx vitest run tests/subagent-policy-error-handling.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify line budget (AP-019)**
Check `wc -l src/runner/subagent.ts` (< 200 LOC).

- [ ] **Step 6: Commit**
```bash
git add src/runner/subagent.ts src/runner/subagent-role.ts tests/subagent-policy-error-handling.test.ts
git commit -m "fix(subagent): handle model policy errors gracefully and enforce recursion depth guard"
```

---

### Task 7: P1 Background Subagent Anchor Lookup Alignment (AP-013, AP-035)

**Boundary:** Runner Domain / Subagent Conversation Index  
**Files:**
- Modify: `src/runner/subagent.ts:70-115`
- Test: `tests/subagent-background-lookup.test.ts`

- [ ] **Step 1: Write failing test for background conversation replay duplication**
In `tests/subagent-background-lookup.test.ts`, start a background subagent, simulate turn replay / crash recovery, and verify that `subagent.execute` finds the existing background conversation instead of creating a second conversation due to `api.taskId` vs `anchorId` mismatch.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/subagent-background-lookup.test.ts`
Expected: FAIL (creates duplicate conversation or fails to resume).

- [ ] **Step 3: Align lookup key in `SubagentsDoc`**
In `src/runner/subagent.ts`, look up existing conversations by matching the agent record in `SubagentsDoc` (which indexes both `anchorTaskId` and `conversationId`) before performing raw `scanConversations`. Ensure ownership mapping is consistent.

- [ ] **Step 4: Verify test passes**
Run: `npx vitest run tests/subagent-background-lookup.test.ts`
Expected: PASS (deterministic resumption without duplicate conversations).

- [ ] **Step 5: Verify line budget (AP-019)**
Check `wc -l src/runner/subagent.ts` (< 200 LOC).

- [ ] **Step 6: Commit**
```bash
git add src/runner/subagent.ts tests/subagent-background-lookup.test.ts
git commit -m "fix(subagent): align background conversation lookup with SubagentsDoc index"
```

---

### Task 8: P1 Stdin Command Queue & Host Event Serialization (AP-023, AP-034)

**Boundary:** IPC Transport & Host Process Manager  
**Files:**
- Modify: `src/runner/index.ts:150-185`
- Modify: `src/host/runner-process.ts:80-110`
- Test: `tests/runner-command-queue.test.ts`

- [ ] **Step 1: Write failing test for parallel stdin commands and out-of-order host events**
In `tests/runner-command-queue.test.ts`:
1. Feed 5 JSONL commands rapidly into stdin; verify they execute sequentially without concurrency races in SQLite.
2. Emit rapid `agent_end` followed by `turn_end`; verify host `onEvent` processes them in strict FIFO order.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/runner-command-queue.test.ts`
Expected: FAIL (unsequenced parallel execution).

- [ ] **Step 3: Implement Promise Queue in `runner/index.ts` and `host/runner-process.ts`**
1. In `src/runner/index.ts`, sequence incoming stdin lines using a promise chain (`let stdinQueue = Promise.resolve(); stdinQueue = stdinQueue.then(async () => handleActiveSessionCommand(...));`).
2. In `src/host/runner-process.ts`, maintain an `eventQueue = Promise.resolve()` chain for `this.options.onEvent?.(msg)` to guarantee strict FIFO ordering.

- [ ] **Step 4: Verify test passes**
Run: `npx vitest run tests/runner-command-queue.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify line budget (AP-019)**
Check `wc -l src/runner/index.ts src/host/runner-process.ts` (< 200 LOC each).

- [ ] **Step 6: Commit**
```bash
git add src/runner/index.ts src/host/runner-process.ts tests/runner-command-queue.test.ts
git commit -m "fix(ipc): enforce sequential FIFO execution for stdin commands and host event stream"
```

---

### Task 9: P1 Atomic Bindings & Monitored Mirror Spawning (AP-012, AP-013, AP-034)

**Boundary:** Host Infrastructure / Binding Store & Spawner  
**Files:**
- Modify: `src/host/durable-binding-store.ts:35-70`
- Modify: `src/host/session-subagent-handler.ts:85-120`
- Test: `tests/binding-store-atomic.test.ts`

- [ ] **Step 1: Write failing test for concurrent binding overwrite and swallowed spawn failure**
In `tests/binding-store-atomic.test.ts`:
1. Simulate concurrent writes to `adapter-bindings.json`; assert no lost updates.
2. Simulate a failure/timeout in `spawnSubthreadInBb`; assert an error diagnostic event is emitted into the session.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/binding-store-atomic.test.ts`
Expected: FAIL (non-atomic write, spawn failure silently swallowed).

- [ ] **Step 3: Implement atomic file write and monitored spawn promise**
1. In `src/host/durable-binding-store.ts`, implement atomic write via temp file + `renameSync`, protected with proper file locking.
2. In `src/host/session-subagent-handler.ts`, attach `.catch(...)` to the spawn promise, emit a diagnostic error event into the parent thread when spawning fails, and prevent buffer starvation.

- [ ] **Step 4: Verify test passes**
Run: `npx vitest run tests/binding-store-atomic.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify line budget (AP-019)**
Check `wc -l src/host/durable-binding-store.ts src/host/session-subagent-handler.ts` (< 200 LOC each).

- [ ] **Step 6: Commit**
```bash
git add src/host/durable-binding-store.ts src/host/session-subagent-handler.ts tests/binding-store-atomic.test.ts
git commit -m "fix(host): make binding store atomic and monitor subthread spawn failures"
```

---

### Task 10: P1 Task Tokens Metrics Calculation (AP-012, AP-013)

**Boundary:** UI Presentation / Runtime Graph Builder  
**Files:**
- Modify: `src/ui/runtime-graph/tree-builder.ts:130-155`
- Test: `tests/task-tokens-calculation.test.ts`

- [ ] **Step 1: Write failing test for negative token deltas in runtime graph**
In `tests/task-tokens-calculation.test.ts`, feed task nodes with distinct generation token usage. Assert that `tokenDelta` values are non-negative and accurately reflect generation token usage.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/task-tokens-calculation.test.ts`
Expected: FAIL (negative delta produced).

- [ ] **Step 3: Fix token delta calculation in `tree-builder.ts`**
Treat `task-tokens.ts` extraction as per-generation usage rather than a monotonic cumulative counter, eliminating erroneous subtractions and negative deltas.

- [ ] **Step 4: Verify test passes**
Run: `npx vitest run tests/task-tokens-calculation.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify line budget (AP-019)**
Check `wc -l src/ui/runtime-graph/tree-builder.ts` (< 200 LOC).

- [ ] **Step 6: Commit**
```bash
git add src/ui/runtime-graph/tree-builder.ts tests/task-tokens-calculation.test.ts
git commit -m "fix(ui): correct token delta metrics calculation in runtime task tree"
```

---

### Task 11: P2 GoF Strategy: Wire `DurablePluginRegistry` into Composition Root (AP-010, AP-014)

**Boundary:** Runner Composition Root / Strategy Pattern  
**Files:**
- Modify: `src/runner/runtime-loader.ts:90-140`
- Modify: `src/runner/harness-setup.ts:90-135`
- Modify: `src/runner/runtime-types.ts`
- Test: `tests/plugin-strategy-wiring.test.ts`

- [ ] **Step 1: Write failing test verifying plugin registry initialization in runtime**
In `tests/plugin-strategy-wiring.test.ts`, instantiate runtime with a custom test `DurablePlugin` passed in `OpenDurableOptions.plugins`. Verify its `init` hook is called and its tools are installed in the coding agent registry. Currently, `OpenDurableOptions` has no plugins field and `createCodingRegistry` is hardcoded.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/plugin-strategy-wiring.test.ts`
Expected: FAIL (plugins not accepted or initialized).

- [ ] **Step 3: Wire `DurablePluginRegistry` in `runtime-loader.ts`**
1. Add `plugins?: DurablePlugin[]` to `OpenDurableOptions`.
2. In `src/runner/runtime-loader.ts`, instantiate `DurablePluginRegistry`, register built-in plugins (`codingToolsPlugin`, `codemodePlugin`, `subagentsPlugin`), register any custom `options.plugins`, and initialize them via `initAll(context)`.
3. Refactor `harness-setup.ts` so `createCodingRegistry` delegates tool installation to the registry plugins.

- [ ] **Step 4: Verify test passes**
Run: `npx vitest run tests/plugin-strategy-wiring.test.ts`
Expected: PASS (built-ins and custom plugins initialize polymorphically via GoF Strategy).

- [ ] **Step 5: Verify line budget (AP-019)**
Check `wc -l src/runner/runtime-loader.ts src/runner/harness-setup.ts` (< 200 LOC each).

- [ ] **Step 6: Commit**
```bash
git add src/runner/runtime-loader.ts src/runner/harness-setup.ts src/runner/runtime-types.ts tests/plugin-strategy-wiring.test.ts
git commit -m "feat(runner): wire DurablePluginRegistry into runtime loader for GoF Strategy parity"
```

---

### Task 12: Dual-Circuit Verification (S9), AP-019 Line Budgets, and Ledger Update

**Boundary:** Quality Gate & Verification  
**Files:**
- Modify: `package.json` (bump version to 0.4.1)
- Modify: `docs/arch-improvement/ledger.md` (add Cycle 100 section)
- Modify: `docs/arch-improvement/memory.md` (record lessons learned)

- [ ] **Step 1: Run layer boundary firewall**
Run: `node scripts/verify-layer-boundaries.mjs`
Expected: PASS (0 cross-layer boundary violations).

- [ ] **Step 2: Run import graph acyclicity**
Run: `node scripts/verify-import-graph.mjs`
Expected: PASS (0 cycles across all source files).

- [ ] **Step 3: Run full test suite**
Run: `npm test`
Expected: PASS (all 715+ unit, integration, and UI tests green).

- [ ] **Step 4: Verify AP-019 line budgets**
Run: `find src -name "*.ts" -o -name "*.tsx" | xargs wc -l | sort -n | tail -n 15`
Expected: All files < 200 LOC, absolute ceiling < 250 LOC.

- [ ] **Step 5: Run contract type check**
Run: `npx tsc --noEmit && npm run test:contracts`
Expected: PASS (0 type errors, negative contract tests pass).

- [ ] **Step 6: Update ledger and memory**
Record Cycle 100 in `docs/arch-improvement/ledger.md` and `docs/arch-improvement/memory.md`.

- [ ] **Step 7: Final commit and build**
```bash
npm run build
git add package.json package-lock.json dist/ docs/arch-improvement/
git commit -m "release(v0.4.1): complete Cycle 100 Sovereign Shield with zero abstraction leaks"
```
