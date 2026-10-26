# Runtime Graph Review Fixes Slice Plan (G1/G2 Findings Remediation)

**Date:** 2026-10-26  
**Target:** Remediate ONLY the 5 graph-specific findings from `s9-runtime-graph-backend.md` in `bb-plugin-provider-pi-durable`.  
**Scope Boundary:**  
- **IN:** `src/runtime-graph/*` (schema/types/status), `src/runner/runtime-graph-*` & `src/runner/index.ts` (graph wiring), `src/host/runtime-graph-delta.ts`, `src/host/delta-translator.ts` & `src/host/session-subagent-handler.ts` (graph delivery), `src/ui/runtime-graph/*`, related tests.
- **OUT:** `session-admission/*`, `session-registry/*`, creation ports (handled by admission worker), renderer/G3, packaging/dist/git.

---

## 1. Finding Breakdown & Remediation Architecture

### Finding 1 [P1]: Missing receipt != authoritative orphaned; live wiring in entrypoint
- **Problem:** Normal task completion naturally evicts tasks from live `view.current().tasks`. With no real wiring in `runner/index.ts` to authoritative commits or `harness.getTask()`, `reconcileDisappearedNodes` synthesized an invented `outcome: "orphaned"`.
- **Fix:**
  1. In `src/runner/runtime-graph-source.ts`: Wire `RuntimeGraphSource` to accept an optional `HarnessGraphSource` interface (`subscribeCommits`, `getTask`) and subscribe to commit publications.
  2. When commits announce `{ type: "task", value: taskRecord }` where `taskRecord.state.status === "terminal"`, invoke `this.receipts.recordTerminal(taskRecord)` with real outcome.
  3. For disappeared nodes lacking a receipt: query `harness.getTask()`. If unobserved/unavailable, treat as unavailability/incompleteness (`observation.completeness = "limited"`), NEVER invent an outcome (`reconcileDisappearedNode` must never synthesize fake orphaned receipts).
  4. In `src/runner/index.ts`: Pass `durable.harness` to `RuntimeGraphSource`.

### Finding 2 [P1]: Platform-independent UTF8 byte bound in browser schema
- **Problem:** `Buffer.byteLength(json, "utf8")` throws `ReferenceError` in browser/Electron UI environments where `Buffer` is undefined. The catch block returned `false`, rejecting all valid snapshots.
- **Fix:**
  1. Implement `getUtf8ByteLength(str: string): number` in `src/runtime-graph/schema.ts` supporting `Buffer` (if defined), `TextEncoder` (standard in browser & modern Node), and a pure JS UTF8 calculation fallback.
  2. Add regression test deleting `globalThis.Buffer` and proving `runtimeGraphSnapshotSchema.safeParse` succeeds.

### Finding 3 [P2]: Deduplication before revision/timestamp
- **Problem:** `++this.revision` and `this.clock()` were updated *before* comparing `serialized === this.lastPublishedJson`. Since revision and timestamp always differed, dedup never succeeded, causing delta spam.
- **Fix:**
  1. Compare structural graph state (`nodes`, `conversations`, `receipts`, `completeness`, `stats`) before incrementing revision and sampling timestamp.
  2. If structural state is unchanged, return immediately without bumping revision/clock and without publishing.

### Finding 4 [P2]: Conversation scope and actual child graph delivery in host
- **Problem:** `runtime_graph_snapshot` had no `conversationId` on wire, `delta-translator.ts` did not forward `conversationId` to `translateRuntimeGraphSnapshot`, and `session-subagent-handler.ts` did not fan out whole-session snapshots to child threads.
- **Fix:**
  1. In `src/host/delta-translator.ts`: Pass `event.conversationId` into `translateRuntimeGraphSnapshot(event, event.conversationId)`.
  2. In `src/host/session-subagent-handler.ts`: When `runtime_graph_snapshot` arrives:
     - If whole-session (no `conversationId`): fan out filtered snapshots to all active/registered child subagents (`translateRuntimeGraphSnapshot(event, childConvId)` -> `thread/delta`), and buffer for pending ones. Do NOT drop from parent.
     - If child-scoped: translate and deliver to the specific child thread.

### Finding 5 [P2]: Owner chain persistence after owner task completion
- **Problem:** `conversations` was rebuilt per-publish solely from live nodes (`node.conversations`). Once the creator task terminated, `owner: { conversationId, taskId }` vanished.
- **Fix:**
  1. In `src/runner/runtime-graph-source.ts`: Maintain a persistent map of known conversations across publications.
  2. Track conversation ownership from `ConversationRecord` (via `subscribeCommits` or initial load) and from live nodes.
  3. Retain conversation owner links even after the creator task becomes terminal and enters receipts.

---

## 2. Test-Driven Development (TDD) Plan

1. **RED Phase 1 (Buffer in browser schema):**
   - Add test in `tests/runtime-graph-contract.test.ts` removing `globalThis.Buffer` and validating schema parsing.
2. **GREEN Phase 1:**
   - Implement `getUtf8ByteLength` in `src/runtime-graph/schema.ts`. Verify test passes.
3. **RED Phase 2 (Dedup before revision/timestamp):**
   - Add test in `tests/runtime-graph-source.test.ts` showing duplicate view state does not increment revision or re-emit.
4. **GREEN Phase 2:**
   - Implement structural comparison before revision increment in `src/runner/runtime-graph-source.ts`. Verify test passes.
5. **RED Phase 3 (Owner chain retention & Authoritative task receipts):**
   - Add tests in `tests/runtime-graph-ownership.test.ts` and `tests/runtime-graph-source.test.ts` proving:
     - Creator task completion retains `conversations[id].owner`.
     - Live task completion via commit/lookup produces authoritative receipt with real outcome.
     - Disappearance without receipt sets `completeness: "limited"` and NEVER invents orphaned outcome.
6. **GREEN Phase 3:**
   - Update `RuntimeGraphReceiptsCollector`, `RuntimeGraphSource`, and wire `durable.harness` in `src/runner/index.ts`.
7. **RED Phase 4 (Host child graph fanout):**
   - Add test in `tests/runtime-graph-bridge.test.ts` showing host delivers scoped graph snapshot deltas to registered child subthreads.
8. **GREEN Phase 4:**
   - Implement fanout in `src/host/session-subagent-handler.ts` and `src/host/delta-translator.ts`.

---

## 3. Invariants & Constraints Check
- Line budgets: every touched `.ts` file must stay strictly < 200 lines (AP-019).
- Import graph: no circular dependencies (AP-025).
- Single Harness public API only: no second Harness, no private SQL, no custom FSM.
- No dist rebuild or shared build while admission worker is running.
