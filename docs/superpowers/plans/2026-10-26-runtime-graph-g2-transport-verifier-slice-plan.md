# G2 Live Transport Verifier — Implementation Slice Plan

**Date:** 2026-10-26  
**Repository:** `/Users/vanya/Projects/bb-plugin-provider-pi-durable`  
**Slice:** G2 Live Roundtrip Transport Verification Tool  
**Phase:** Current 0.3.x Architecture Loop  

---

## 1. Goal & Architectural Bounds

- **Goal:** Create a robust, modular, standalone verification tool to prove and monitor the end-to-end delivery of `extension.state` (`provider-pi-durable/runtime-graph` -> `thread/extensionState/updated` -> `readRuntimeGraphSnapshot` -> `thread:changed` realtime invalidation) in live Beyond Boundaries.
- **Strict Bounds:**
  - DO NOT mutate the installed plugin (`0.2.53`) or run cutover without operator confirmation.
  - DO NOT probe or send test messages to existing user threads or original sessions.
  - DO NOT fabricate live test results: CLI must clearly differentiate between `PASS`, `FAILED`, and `BLOCKED`.
  - When candidate version 0.3.x is not active in the running BB runtime (currently installed is 0.2.53 with absent extensionKind), immediately return `BLOCKED` with actionable remediation and DO NOT spawn useless model runs.
  - DO NOT hide leaks or socket hangs with forced `process.exit(0)`.
  - All TS/TSX files strictly < 200 lines (AP-019).

---

## 2. Verified Seams & Integration Points

1. **BB Server REST API:**
   - Endpoint: `GET /api/v1/threads/:id/events`
   - Parameters: `types=thread/extensionState/updated`, `order=desc`, `limit=100`, `beforeSeq=...`
   - Payload structure: raw database event rows where extension state kind and payload are nested inside `row.data` (or at top level in SDK adapters).
   - Client read seam: `src/ui/runtime-graph/read.ts` updated to seamlessly unwrap both top-level and `data`-nested properties without altering public semantics.

2. **BB Realtime WebSocket API:**
   - Protocol: `ws://<server>/ws`
   - Subscription payload: `{"type": "subscribe", "target": {"kind": "thread-detail", "threadId": "<id>"}}`
   - Invalidation event: `{"type": "changed", "entity": "thread", "id": "<id>", "changes": ["events-appended"]}`
   - Unsubscription payload: `{"type": "unsubscribe", "target": {"kind": "thread-detail", "threadId": "<id>"}}`

3. **Readiness & Generation Gate:**
   - Query `/api/v1/plugins` to inspect `provider-pi-durable` version (requires `>= 0.3.0`).
   - Query `/api/v1/system/providers` to inspect `pi-durable` capabilities (requires `extensionKinds` declaring `provider-pi-durable/runtime-graph`).

---

## 3. Modular File Breakdown (All < 200 LOC)

1. `scripts/g2-transport/readiness.mjs` (~125 lines):
   - Pure readiness inspector: verifies BB server reachability, installed plugin version `>= 0.3.0`, and declared `extensionKinds`.
2. `scripts/g2-transport/client.mjs` (~135 lines):
   - Public BB transport client: implements `RuntimeGraphRealtimeClient` (`threads.events.list` and `realtime.subscribe`) over Node.js fetch and native WebSocket, with explicit `close()` cleanup.
3. `scripts/g2-transport/verifier.mjs` (~150 lines):
   - Core verification orchestration: subscribes to realtime `thread:changed` BEFORE turn actions, tracks `subscribeRuntimeGraph` updates, validates schema and scope, drops stale revisions, enforces timeouts, cleans up all listeners.
4. `scripts/verify-live-g2-transport.mjs` (~180 lines):
   - Executable CLI entrypoint with `--help`, `--readiness`, `--thread <id>`, `--conversation <id>`, `--timeout <ms>`, `--server <url>`, `--json`. Sets clean exit codes (0 = PASS, 1 = FAILED, 2 = BLOCKED).
5. `src/ui/runtime-graph/read.ts` (119 lines):
   - Minimally adapted read seam supporting both `{ kind, payload }` and `{ data: { kind, payload } }`.

---

## 4. TDD Behavioral Verification Matrix

- `tests/runtime-graph-public-events.test.ts` (176 lines):
  - Added scenario for reading snapshots nested inside `event.data` envelope.
- `tests/verify-live-g2-transport.test.ts` (137 lines):
  - **TDD Test 1:** Success correlation: receives realtime invalidation, fetches extension state, parses snapshot ok -> PASS.
  - **TDD Test 2:** Invalid payload: detects schema violation in extension.state and reports FAILED.
  - **TDD Test 3:** Wrong scope: detects mismatched session or conversation scope and reports FAILED.
  - **TDD Test 4:** Timeout and cleanup: unregisters realtime listener, aborts in-flight fetch and reports FAILED on timeout.
- `tests/verify-live-g2-scenarios.test.ts` (128 lines):
  - **TDD Test 5:** Stale or out-of-order: ignores earlier epoch or lower revision and preserves newest snapshot.
  - **TDD Test 6:** Explicit blocked environment: returns BLOCKED when installed provider is < 0.3.0 (e.g. 0.2.53).
  - **TDD Test 7:** Readiness check returns BLOCKED when installed version is 0.2.53.
  - **TDD Test 8:** Readiness check returns READY when version >= 0.3.0 with extensionKind.
