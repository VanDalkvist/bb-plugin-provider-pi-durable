# Arch Improvement Cycle 99 — Sovereign Hexagonal Kernel & Extension Parity (v0.4.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the Pi Durable agent harness (`src/runner`) into an autonomous, sovereign computing hexagon by eliminating all Beyond Boundaries host leaks (raw SQLite access, client `threadId` storage, out-of-band FD 3/4 readiness, BB Core title limits) and achieving first-class parity for external Pi extensions (`sendUserMessage` submission to Durable FSM, multi-path `--extension`, and `--no-global-extensions` isolation).

**Architecture Context Reference:**
- `docs/arch-improvement/cycle-99-decoupling-audit.md` (Verdict: FAIL; 4 P1 and 3 P2 architectural defects identified).
- Thread `@thread:thr_768j569grv` (Herdr / Delm / Andrey's taskboard extension blockers).
- `~/Projects/arch-rules/arch-rules.md` (AP-010, AP-011, AP-012, AP-013, AP-014, AP-016, AP-018, AP-019, AP-020, AP-021, AP-022, AP-026, AP-028).

**Tech Stack:** TypeScript 5.7, Node.js 24 (`node:sqlite`, `node:child_process`), `@earendil-works/pi-durable` 1.4, `@earendil-works/pi-coding-agent`, Zod 3.24, Node Test Runner.

---

## 1. Architecture Context Map & Quality Invariants

```markdown
Architecture Context Map
- Stage: prod (v0.4.0 Sovereign Decoupled Kernel & Extension Parity)
- Source docs: 
  - docs/arch-improvement/cycle-99-decoupling-audit.md
  - docs/arch-improvement/ledger.md
  - ~/Projects/arch-rules/arch-rules.md
- Critical AP gates:
  - AP-010 (Ports & Adapters): Runner is a pure computing hexagon; Host is an external presentation adapter.
  - AP-011 (Low Coupling): Zero client thread concepts (threadId) inside src/runner/ domain/storage.
  - AP-012 (Fail-Fast): Invalid requests or failed submissions throw typed errors immediately; zero empty stubs.
  - AP-013 (Data Integrity): sendUserMessage reliably submits turns to Durable FSM via controller.submit().
  - AP-014 (Strategy Pattern): Dynamic extension assembly driven by DurablePluginRegistry.
  - AP-016 (Security & Boundary): Host NEVER opens runner's session.sqlite via raw SQL DatabaseSync.
  - AP-018 (Single Responsibility): Runner emits pure domain events; Host formats UI presentation cards.
  - AP-019 (Line Budgets): All modified and new .ts files strictly < 200 LOC (hard ceiling 250).
  - AP-020 (Clean Architecture): Domain logic has zero dependencies on Beyond Boundaries host infrastructure.
  - AP-021 (Transport Portability): Standard POSIX stdio (stdin/stdout) is the primary transport; FD 3/4 is strictly optional.
  - AP-028 (Deterministic Testing): 100% green tests across contract, unit, and UI suites.
```

---

## 2. Findings Triage Matrix (Selected for Fix-Now)

| Finding ID | Severity | Area | Root Cause & Architectural Defect | Target Fix Slice |
|---|---|---|---|---|
| **F-99-1** | **P1** | Storage & DIP | `threadId` and `parentThreadId` persisted in SQLite `BindingDoc` | **Slice 1** |
| **F-99-2** | **P1** | Boundary Leak | `durable-binding-store.ts` directly opens `session.sqlite` via raw SQL | **Slice 1** |
| **F-99-3** | **P1** | Transport IPC | `ready` signal emitted ONLY on FD 3; ENXIO in standard POSIX terminal | **Slice 2** |
| **F-99-4** | **P1** | Extension FSM | `sendUserMessage: () => {}` in `extension-bridge.ts` drops prompts silently | **Slice 3** |
| **F-99-5** | **P1** | Host Bleed | `subagent.ts` truncates tasks via `nativeChildTitle` for BB `threads.title <= 500` | **Slice 4** |
| **F-99-6** | **P2** | Extension CLI | `--extension` in `cli-args.ts` only accepts 1 scalar string, overwriting paths | **Slice 5** |
| **F-99-7** | **P2** | Isolation | No `--no-global-extensions` flag; global `~/.pi/` extensions pollute sessions | **Slice 5** |
| **F-99-8** | **P2** | Strategy Pattern | `DurablePluginRegistry` orphaned; `harness-setup.ts` hardcodes tools | **Slice 6** |
| **F-99-9** | **P2** | Wire Protocol | Dead `PlanStep` / `tasks_snapshot` presentation schemas in `wire-lifecycle.ts` | **Slice 4** |
| **F-99-10** | **P2** | Facade | `openDurable()` in `runtime.ts` does not wire streams/graph for library usage | **Slice 6** |

---

## 3. Product Verification: Golden Journeys (S9b Protocol)

The implementation must pass black-box verification against these three journeys:

### Journey 1: Standalone Headless POSIX Execution (Zero FD 3/4, Pure Stdio)
- **Action:** Launch the runner directly from a standard terminal:
  `node dist/runner/index.js --mode rpc --session /tmp/test_session/session.sqlite`
- **Verification:**
  - Emits JSONL `{"type":"ready"}` on `stdout` without throwing `ENXIO`.
  - Process does not hang or require FD 3/4.
  - Accepts domain command: `{"type":"prompt","id":"1","conversationId":1,"message":"hello"}` and streams `RunnerEvent` frames.
  - `/tmp/test_session/session.sqlite` contains ZERO `durable.binding` or client UI thread rows.

### Journey 2: External Extension Turn Submission (`sendUserMessage` Parity)
- **Action:** Load a custom Pi extension `custom-ext.ts` calling:
  `pi.sendUserMessage("Automated task from extension", { deliverAs: "followUp" })`
- **Verification:**
  - `sendUserMessage` does NOT resolve as a blank no-op.
  - The message is reliably submitted to `durable.controller.submit(...)`.
  - The Durable FSM initiates a turn, executes tools, and commits entries into the SQLite WAL.

### Journey 3: Isolated Multi-Extension Session Spawn
- **Action:** Launch runner with multiple extensions and global isolation:
  `node dist/runner/index.js --extension ./ext1.ts --extension ./ext2.ts --no-global-extensions`
- **Verification:**
  - Both `ext1.ts` and `ext2.ts` are mounted and their tools/hooks registered.
  - Extensions from `~/.pi/agent/extensions` are NOT loaded.
  - Zero pollution in non-target workspaces.

---

## 4. Implementation Slices & Architecture Boundaries

### Slice 1: Storage Sovereignty & Elimination of Host Raw SQL (F-99-1, F-99-2)
- **Boundary:** Domain Storage & Persistence (AP-010, AP-011, AP-016, AP-020)
- **AP gates:** AP-010, AP-011, AP-016, AP-020
- **Files:**
  - Delete: `src/runner/binding-docs.ts` (Retire `BindingDoc` and `BindingIndexDoc`).
  - Delete: `src/runner/binding-commands.ts` (Retire `register_binding`, `get_all_bindings` from runner).
  - Modify: `src/contracts/runner-command.ts` (Remove `register_binding`, `get_all_bindings`, `threadId`).
  - Modify: `src/runner/session-commands.ts` (Clean command dispatcher).
  - Modify: `src/host/durable-binding-store.ts` (Store `threadId` <-> `conversationId` mapping in host sidecar `~/.durable/sessions/<sessionId>/host-bindings.json`; completely delete raw SQL `DatabaseSync` opening of `session.sqlite`).
  - Modify: `src/host/session.ts` (Host manages thread mappings locally via `host-bindings.json` without runner RPC).
  - Modify: `src/runner/subagent-watcher.ts` (Discover child conversations purely via FSM task records, not by querying host thread IDs).
  - Test: `tests/storage-sovereignty.test.ts`
- **Red test first:**
  - `tests/storage-sovereignty.test.ts`:
    * Assert `session.sqlite` contains ZERO `durable.binding` documents.
    * Assert `durable-binding-store.ts` does NOT open `session.sqlite` with `DatabaseSync`.
    * Assert host thread mappings persist and restore cleanly from `host-bindings.json`.
- **Implementation:**
  - Purge thread documents from runner.
  - Implement host-side JSON sidecar store in `DurableBindingManager`.
  - Update `subagent-watcher.ts` to track conversations by integer `conversationId`.
  - Ensure all files < 150 LOC (AP-019).
- **Verification:** `node --test tests/storage-sovereignty.test.ts tests/durable-binding-store.test.ts` PASS.
- **Stop condition:** Any raw SQL access to `session.sqlite` from host code or client thread IDs in runner SQLite.

---

### Slice 2: Transport Protocol Portability (Stdio Readiness & Optional FD 3/4) (F-99-3)
- **Boundary:** Transport / IPC Infrastructure (AP-021, AP-027)
- **AP gates:** AP-021, AP-027
- **Files:**
  - Modify: `src/runner/bridge-channel.ts` (Check if FD 3 is valid before writing; fallback to `stdout`).
  - Modify: `src/runner/index.ts` (Emit JSONL `{"type":"ready","pid":process.pid}` to `stdout` upon full initialization, and mirror to FD 3 only if open).
  - Modify: `src/host/runner-process.ts` (Listen for `ready` either from FD 3 channel message OR from `stdout` JSONL frame).
  - Test: `tests/posix-stdio-transport.test.ts`
- **Red test first:**
  - Launch runner via standard `spawn("node", ["dist/runner/index.js", ...], { stdio: ["pipe", "pipe", "pipe"] })` (with NO FD 3 or FD 4).
  - Assert runner emits `{"type":"ready"}` on `stdout` within 2 seconds.
  - Assert process does NOT throw `ENXIO` or crash on startup.
- **Implementation:**
  - In `bridge-channel.ts`: wrap FD operations with file descriptor validation (`fstatSync`).
  - In `index.ts`: send ready frame to `stdout`.
  - In `runner-process.ts`: handle both stdout ready frame and out-of-band FD 3 message.
  - Ensure all files < 150 LOC (AP-019).
- **Verification:** `node --test tests/posix-stdio-transport.test.ts` PASS.
- **Stop condition:** Runner hanging or crashing when spawned without file descriptors 3 and 4.

---

### Slice 3: Extension Action Parity (`sendUserMessage` & `sendMessage` in FSM) (F-99-4)
- **Boundary:** Extension Bridge & Durable FSM (AP-012, AP-013, AP-029)
- **AP gates:** AP-012, AP-013, AP-029
- **Files:**
  - Modify: `src/runner/extension-mount.ts` (Add `onSubmitUserMessage` and `onSendMessage` to `ExtensionActionsDelegate`).
  - Modify: `src/runner/extension-bridge.ts` (Implement `sendUserMessage` and `sendMessage` calling `options.actionsDelegate`).
  - Modify: `src/runner/runtime.ts` (Wire `actionsDelegate.onSubmitUserMessage` to `controller.submit(content, deliverAs ?? "followUp")`).
  - Test: `tests/extension-user-message.test.ts`
- **Red test first:**
  - Mock an extension calling `pi.sendUserMessage("Hello from extension", { deliverAs: "followUp" })`.
  - Assert the prompt is received by `controller.submit` and turn execution starts.
  - Assert calling `sendUserMessage` does NOT resolve as a blank no-op.
- **Implementation:**
  - Implement delegation contract in `extension-bridge.ts`.
  - Wire to `durable.controller.submit(...)` in `runtime.ts`.
  - Ensure all files < 150 LOC (AP-019).
- **Verification:** `node --test tests/extension-user-message.test.ts` PASS.
- **Stop condition:** Any extension prompt dropped silently into `() => {}`.

---

### Slice 4: Domain & Contract Purification (Purge BB UI Schemas & Title Limits) (F-99-5, F-99-9)
- **Boundary:** Domain Core & Wire Contracts (AP-011, AP-014, AP-018, AP-026)
- **AP gates:** AP-011, AP-014, AP-018, AP-026
- **Files:**
  - Modify: `src/contracts/wire-lifecycle.ts` (Remove `planStepSchema` and `tasksSnapshotSchema`).
  - Modify: `src/runner/bridge/durable-event-adapter.ts` (Emit pure domain events; zero `tasks_snapshot`).
  - Modify: `src/host/delta-translator.ts` (Map `runtime_graph_snapshot` to BB UI `Plan` / `Steps` deltas directly in host layer).
  - Modify: `src/runner/subagent.ts` & `src/runner/subagent-delivery.ts` (Use full task name as domain name; move 500-char truncation to `src/host/subthread-spawner.ts`).
  - Test: `tests/wire-contract-purity.test.ts`
- **Red test first:**
  - Assert `RunnerEvent` union contains no `tasks_snapshot` or `PlanStep`.
  - Assert task names in `SubagentsDoc` preserve full prompt without artificial 500-character truncations.
  - Assert `DeltaTranslator` formats BB UI deltas from `runtime_graph_snapshot`.
- **Implementation:**
  - Delete presentation schemas from `wire-lifecycle.ts`.
  - Update event adapter and host delta translator.
  - Remove DB column constraints from runner FSM.
  - Ensure all files < 150 LOC (AP-019).
- **Verification:** `node --test tests/wire-contract-purity.test.ts` and `npm run test:contracts` PASS.
- **Stop condition:** Presentation UI schemas surviving in runner wire contracts.

---

### Slice 5: Multi-Extension CLI & Session Isolation (`--no-global-extensions`) (F-99-6, F-99-7)
- **Boundary:** CLI / Environment Configuration (AP-010, AP-020, AP-030)
- **AP gates:** AP-010, AP-020, AP-030
- **Files:**
  - Modify: `src/runner/cli-args.ts` (Parse multiple `--extension <path>` into `string[]`; parse `--no-global-extensions` flag).
  - Modify: `src/runner/runtime-types.ts` (`extensions?: string[]`, `noGlobalExtensions?: boolean`).
  - Modify: `src/runner/runtime-loader.ts` (Pass `additionalExtensionPaths` array and `noExtensions: true` into `DefaultResourceLoader`).
  - Modify: `src/host/types.ts` & `src/host/session-telemetry.ts` (Support `additionalExtensionPaths` in `SessionOptions` and forward to runner CLI).
  - Test: `tests/extension-cli-multi.test.ts`
- **Red test first:**
  - Parse `["--extension", "a.ts", "--extension", "b.ts", "--no-global-extensions"]`.
  - Assert `args.extensions` is `["a.ts", "b.ts"]`.
  - Assert `args.noGlobalExtensions` is `true`.
  - Assert `DefaultResourceLoader` receives `noExtensions: true` when flag is set.
- **Implementation:**
  - Update CLI argument parser and runtime types.
  - Forward array of extensions to resource loader.
  - Ensure all files < 150 LOC (AP-019).
- **Verification:** `node --test tests/extension-cli-multi.test.ts` PASS.
- **Stop condition:** Overwriting `--extension` or failing to isolate global extensions.

---

### Slice 6: Strategy Plugin Assembly & DurableEngine Facade (F-99-8, F-99-10)
- **Boundary:** Plugin Architecture & Public API Facade (AP-010, AP-014, AP-020)
- **AP gates:** AP-010, AP-014, AP-020
- **Files:**
  - Modify: `src/runner/harness-setup.ts` (Connect `DurablePluginRegistry` to mount extensions dynamically).
  - Create: `src/runner/engine.ts` (Export clean `DurableEngine` facade providing cohesive in-process API: `create()`, `prompt()`, `events()`, `abort()`).
  - Modify: `src/runner/runtime.ts` (Wire `DurableEngine` as the canonical facade).
  - Test: `tests/durable-engine-facade.test.ts`
- **Red test first:**
  - Instantiate `DurableEngine` headlessly in-process without CLI or host.
  - Execute a turn and subscribe to domain event stream.
  - Verify built-in plugins (`coding-tools`, `codemode`, `subagents`) mount dynamically via `DurablePluginRegistry`.
- **Implementation:**
  - Wire plugin registry into `harness-setup.ts`.
  - Create `DurableEngine` class (< 150 LOC).
  - Export from `src/runner/index.ts` and `src/runner/engine.ts`.
- **Verification:** `node --test tests/durable-engine-facade.test.ts` PASS.
- **Stop condition:** Hardcoded tool registrations bypassing `DurablePluginRegistry`.

---

### Slice 7: S9 Dual-Circuit Verification Gate & Release v0.4.0
- **Boundary:** System Integration & Release Verification (AP-028)
- **AP gates:** All AP gates (AP-010 through AP-028)
- **Implementation:**
  - Rebuild runner binary: `node scripts/build-runner.mjs`.
  - Run full test suite: `npm test` and `npm run test:contracts`.
- **S9 Dual-Circuit Verification:**
  1. **Circuit 1: Architectural Reviewer (`arch-rules-implementation-review`)**
     - Verify zero client `threadId` in `src/runner/` and zero raw SQL in `src/host/`.
     - Verify all files < 200 LOC (AP-019).
     - Target Verdict: **PASS**.
  2. **Circuit 2: Product Reviewer (`arch-improvement-product-review`)**
     - Execute Journey 1 (Headless POSIX CLI execution).
     - Execute Journey 2 (Extension `sendUserMessage` turn submission).
     - Execute Journey 3 (Multi-extension isolated session).
     - Target Verdict: **PASS**.
  - Update `docs/arch-improvement/ledger.md` (Cycle 99).
  - Bump release version: `0.4.0`.
  - Commit to main and push.
