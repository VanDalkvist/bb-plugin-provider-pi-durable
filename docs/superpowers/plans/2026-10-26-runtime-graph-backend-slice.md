# Runtime Graph Backend Implementation Slice Plan (G1 / G2)

**Date:** 2026-10-26  
**Target:** `/Users/vanya/Projects/bb-plugin-provider-pi-durable`  
**Scope:** G1.1 (DTO & Status), G1.2 (Single-Harness Projection, Ownership & Receipts), G2 (Native Extension State & Public Client Read Seam).  
**Out of Scope (Hard Bounds):**
- NO UI components / G3 renderer (requires separate explicit operator UI-policy approval).
- NO modifications to `src/host/session-registry.ts` or admission concurrency.
- NO git commit, push, version bump, or live plugin installation.
- NO migration rehearsal or opening original user sessions.
- NO custom scheduler, model-generated graph, or private SQLite schema access.

---

## 1. File Breakdown (<200 lines per file, AP-019)

### G1.1: Public DTO, Schemas & Lifecycle Status
1. `src/runtime-graph/types.ts` (~80 lines):
   - TypeScript definitions for `TaskOutcomeName`, `LiveTaskStatus`, `GraphScope`, `GraphObservation`, `RuntimeTaskNode`, `RuntimeConversationNode`, `RuntimeTaskReceipt`, `RuntimeGraphSnapshot`, `ProjectedTaskState`.
2. `src/runtime-graph/schema.ts` (~140 lines):
   - Zod schemas with finite JSON validation, strict bounds (512 live nodes, 128 receipts, <=160 chars label, <=500 chars preview, <=1MiB payload ceiling), discriminated unions for live states and outcomes.
3. `src/runtime-graph/status.ts` (~70 lines):
   - Pure projection `projectTaskState`: exact native status preservation, completing is NOT final success (`isFinal: false`), tool `isError` is separate from `TaskOutcome`, abort requested is a badge, no fake success default.

### G1.2: Single-Harness Projection, Scope & Receipts
4. `src/runner/runtime-graph-scope.ts` (~80 lines):
   - Scope resolution: session, root conversation, subagent conversation subtree mapping, filtering conversations for native child thread vs root thread. Fork parent is NOT owner.
5. `src/runner/runtime-graph-receipts.ts` (~120 lines):
   - Authoritative receipts collector: bounded cache of 128 recent terminal receipts, reconciliation of disappearing live nodes via `session.getTask` / committed records, error extraction from tool results vs task outcomes.
6. `src/runner/runtime-graph-source.ts` (~180 lines):
   - Single-Harness observation: attaches to existing `harness.watchTaskGraph` / `harness.taskGraph`, tracks commits, debounces at 250ms with maximum 1000ms interval (non-starving), enforces 512 live node limit, flushes on drain.
7. Minimal runner integration:
   - Wire `RuntimeGraphSource` into `src/runner/runtime-controller.ts` / `src/runner/runtime-loader.ts` to emit snapshots through `bridgeChannel`.

### G2: Extension State Delta & Public Client Read Seam
8. `src/contracts/runner-event.ts`:
   - Add `runtime_graph_snapshot` event definition (`schema` + TS type) to wire contracts.
9. `src/host/runtime-graph-delta.ts` (~60 lines):
   - Pure delta mapper translating `runtime_graph_snapshot` into BB `extension.state` delta (`extensionKind: "provider-pi-durable/runtime-graph"`).
10. `src/host/delta-translator.ts` & `src/host/session.ts`:
    - Wire `runtime_graph_snapshot` event dispatch through `runtime-graph-delta.ts` to BB provider bridge.
11. `server.ts`:
    - Register `extensionKinds: { "runtime-graph": { state: runtimeGraphSnapshotSchema } }` in `bb.providers.register`.
12. `src/ui/runtime-graph/read.ts` (~130 lines):
    - Public client read function using `sdk.threads.events.list({ types: ["thread/extensionState/updated"] })`, validates schema, pages up to 5 pages of 100, selects newest matching scope/epoch.
13. `src/ui/runtime-graph/subscription.ts` (~110 lines):
    - Public realtime subscription using `sdk.realtime.subscribe({ event: "thread:changed" })`, coalescing invalidations, mount/unmount cleanup.

---

## 2. Test-Driven Development (TDD) Matrix

### G1.1 Tests
- `tests/runtime-graph-contract.test.ts`:
  - **RED**: Schema validation, numeric ID parsing, bounds enforcement (>512 live nodes clamped to `limited`, >160 chars label clamped/rejected, payload >1MiB rejected), cross-session references rejected, sleeping/until and blocked metadata accepted.
  - **GREEN**: Implemented in `schema.ts` and `types.ts`.
- `tests/runtime-graph-status.test.ts`:
  - **RED**: `projectTaskState` asserts `completing` with `outcome: completed` has `isFinal: false`, `abortRequested` does not change state to aborted, tool `isError: true` does not rewrite task outcome `completed` to `failed`.
  - **GREEN**: Implemented in `status.ts`.

### G1.2 Tests
- `tests/runtime-graph-ownership.test.ts`:
  - **RED**: Fork parent vs creator owner edge distinction; nested subagent conversation scoping; ownerless conversations do not leak into child scope; terminal owner retains child conversation.
  - **GREEN**: Implemented in `runtime-graph-scope.ts`.
- `tests/runtime-graph-receipts.test.ts`:
  - **RED**: Disappearing live node becomes reconciling entry until receipt is loaded; fast create+terminal between frames is caught; tool result `isError` produces badge without altering task outcome; 128 receipt capacity ring buffer.
  - **GREEN**: Implemented in `runtime-graph-receipts.ts`.
- `tests/runtime-graph-source.test.ts`:
  - **RED**: Single-Harness observation without starting new tasks; 250ms debouncing with non-starving max flush; 512 live node limit sets `completeness: limited`; drain flushes final transition.
  - **GREEN**: Implemented in `runtime-graph-source.ts`.

### G2 Tests
- `tests/runtime-graph-bridge.test.ts`:
  - **RED**: Runner event `runtime_graph_snapshot` translates to valid BB delta `kind: "extension.state"`, `extensionKind: "provider-pi-durable/runtime-graph"`; schema validates in BB `threadDeltaSchema`.
  - **GREEN**: Implemented in `src/host/runtime-graph-delta.ts` and wire integration.
- `tests/runtime-graph-public-events.test.ts`:
  - **RED**: `readRuntimeGraphSnapshot` queries public `sdk.threads.events.list`, validates `thread/extensionState/updated`, verifies epoch/revision selection, handles pagination limit (500 events).
  - **GREEN**: Implemented in `src/ui/runtime-graph/read.ts`.
- `tests/runtime-graph-reconnect.test.ts`:
  - **RED**: `subscribeRuntimeGraph` attaches realtime listener, handles reconnect, unmount drops timer and subscription, stale epoch discarded.
  - **GREEN**: Implemented in `src/ui/runtime-graph/subscription.ts`.

---

## 3. Verification Commands & Gates

1. **Focused Test Suites:**
   `node --test tests/runtime-graph-contract.test.ts tests/runtime-graph-status.test.ts`
   `node --test tests/runtime-graph-ownership.test.ts tests/runtime-graph-receipts.test.ts tests/runtime-graph-source.test.ts`
   `node --test tests/runtime-graph-bridge.test.ts tests/runtime-graph-public-events.test.ts tests/runtime-graph-reconnect.test.ts`
2. **TypeScript Compilation:**
   `./node_modules/.bin/tsc --noEmit`
   `./node_modules/.bin/tsc --noEmit -p tsconfig.contract-tests.json`
3. **Line Budgets (AP-019):**
   Verify all new/modified `.ts` files <200 lines.
4. **Import Graph (AP-025):**
   `node scripts/verify-import-graph.mjs`
5. **Full Regression Suite:**
   `npm test`
