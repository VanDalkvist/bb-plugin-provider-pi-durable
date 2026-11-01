# True Hexagonal Decoupling & Autonomous Kernel (v0.4.0 Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the Pi Durable runner (`src/runner`) into a truly sovereign, domain-driven Hexagonal kernel by eliminating client thread tracking from core SQLite storage, removing presentation UI artifacts (`PlanStep`, `tasks_snapshot`) from engine wire contracts, abstracting subagent process spawning behind an `ISubagentProcessSpawner` port, and driving extension assembly 100% via the Strategy pattern.

**Architecture Reference:** `docs/arch-improvement/cycle-99-decoupling-audit.md` (Verdict: FAIL on cosmetic decoupling; roadmap defined for architectural decoupling).

**Tech Stack:** TypeScript 5.7, Node.js 24 (`node:sqlite`, `node:child_process`), `@earendil-works/pi-durable` 1.4, Zod 3.24, Node Test Runner.

---

## 1. Implementer Orientation & Required Reading

Before modifying any file, the implementing engineer **MUST** read:
1. `docs/arch-improvement/cycle-99-decoupling-audit.md` (The 5 architectural defects and target hexagonal topology).
2. `src/contracts/wire-lifecycle.ts` and `src/contracts/wire-context.ts` (Current wire schemas).
3. `src/runner/binding-docs.ts` and `src/runner/binding-commands.ts` (Current thread persistence).
4. `src/host/session.ts` and `src/host/durable-binding-store.ts` (Current host-side binding tracking).
5. `src/host/subthread-spawner.ts` and `src/shared/subagent-envelope.ts` (Current subthread spawning coupling).
6. `src/runner/extension-mount.ts` and `src/runner/plugins/` (Current plugin registry & extension wiring).

---

## 2. Architecture Context Map & Invariants

```markdown
Architecture Context Map
- Stage: prod (v0.4.0 true architectural sovereignty)
- Source docs: 
  - docs/arch-improvement/cycle-99-decoupling-audit.md
  - ~/Projects/arch-rules/arch-rules.md
- Critical AP gates:
  - AP-010 (Ports & Adapters): Runner is a pure computing hexagon; BB host is an external presentation adapter.
  - AP-011 (Low Coupling): Zero client thread concepts (threadId, parentThreadId) inside src/runner/ domain/storage.
  - AP-012 (Fail-Fast): Invalid requests or unknown conversation IDs throw typed errors immediately.
  - AP-013 (Data Integrity): SQLite transactions commit deterministically; session storage only holds domain entities.
  - AP-018 (Single Responsibility): Runner emits pure domain events; host translates domain events to UI deltas.
  - AP-019 (Line Budgets): All modified and new .ts files strictly < 200 LOC (hard ceiling 250).
  - AP-020 (Clean Architecture): Domain logic does not depend on host infrastructure.
- Invariant 1 (Storage Purity): The runner's SQLite storage (session.sqlite) MUST NOT store client UI thread IDs.
- Invariant 2 (Contract Purity): Wire contracts MUST NOT contain UI presentation schemas (no PlanStep, no Inline UI shapes).
- Invariant 3 (Headless Portability): Subagent spawning MUST NOT depend on the `bb` CLI binary in headless mode.
```

---

## 3. Product Verification: Golden Journeys (S9b Protocol)

The implementing subagent must verify the system against these three end-to-end journeys:

### Journey 1: Standalone Headless Daemon / CLI Execution
- **Action:** Launch the runner directly:
  `node dist/runner/index.js --mode rpc --session /tmp/headless_test/session.sqlite`
- Send purely domain commands (zero `threadId`):
  `{"type":"prompt","id":"req_1","conversationId":1,"message":"hello headless"}`
- **Verification:**
  - Runner process responds with clean `RunnerEvent` domain stream.
  - SQLite database `/tmp/headless_test/session.sqlite` contains NO `durable.binding` or client UI thread records.
  - Subagents run in-process or via native fork without calling `bb thread spawn`.

### Journey 2: Cold-Start BB IDE Integration
- **Action:** Connect Beyond Boundaries IDE via the host adapter (`src/host/session.ts`).
- **Verification:**
  - Host adapter maintains the `threadId` <-> `conversationId` mapping in its own host-side store.
  - BB receives all needed UI deltas through `DeltaTranslator`.
  - Full test suite passes: `npm test` (700+ tests).

### Journey 3: Error Recovery & Adversarial Inputs
- **Action:** Attempt to call `register_binding` on the runner.
- **Verification:**
  - Runner rejects command with `InvalidCommandPayloadError` (command is retired/unrecognized in headless kernel).
  - Host side handles thread mapping locally without throwing.

---

## 4. Implementation Slices

### Slice 1: Purge Client Threads from Kernel Storage & Schema (AP-010, AP-011)
- **Boundary:** Domain Storage & Persistence
- **AP gates:** AP-010, AP-011, AP-013, AP-020
- **Files:**
  - Delete: `src/runner/binding-docs.ts` (Retire `BindingDoc`, `BindingIndexDoc`).
  - Delete: `src/runner/binding-commands.ts` (Retire `register_binding`, `get_all_bindings` from runner).
  - Modify: `src/contracts/runner-command.ts` (Remove `register_binding`, `get_all_bindings`, `threadId`).
  - Modify: `src/runner/session-commands.ts` (Clean command dispatcher).
  - Modify: `src/host/durable-binding-store.ts` (Move thread-to-conversation mapping entirely to host-side store `~/.durable/sessions/<sessionId>/host-bindings.json`).
  - Modify: `src/host/session.ts` (Host maintains thread mappings locally, does not sync to runner SQLite).
  - Test: `tests/sovereign-storage-purity.test.ts`
- **Red test first:**
  - Assert runner `session.sqlite` documents table contains ZERO records of kind `durable.binding`.
  - Assert runner commands schema strictly accepts `conversationId` and rejects `threadId`.
  - Assert host adapter persists and restores thread mappings in `host-bindings.json`.
- **Implementation:**
  - Strip thread tracking from runner kernel.
  - Encapsulate thread binding in host adapter.
  - Ensure all files < 150 LOC (AP-019).
- **Verification:** `node --test tests/sovereign-storage-purity.test.ts` PASS.
- **Stop condition:** Any persistence of client `threadId` into `session.sqlite`.

---

### Slice 2: Wire Contract Purification & Presentation Decoupling (AP-014, AP-018)
- **Boundary:** Wire Protocol & Presentation Decoupling
- **AP gates:** AP-014, AP-018, AP-020
- **Files:**
  - Modify: `src/contracts/wire-lifecycle.ts` (Remove `planStepSchema` and `tasksSnapshotSchema`).
  - Modify: `src/runner/bridge/durable-event-adapter.ts` (Emit pure domain events: `runtime_graph_snapshot`, `task_state_changed`).
  - Modify: `src/host/delta-translator.ts` (Map `runtime_graph_snapshot` to BB UI `Plan` / `Steps` deltas directly in the host layer).
  - Test: `tests/wire-contract-purity.test.ts`
- **Red test first:**
  - Assert `RunnerEvent` union contains no `tasks_snapshot` or `PlanStep`.
  - Assert `DeltaTranslator` converts domain `runtime_graph_snapshot` into BB presentation deltas without runner having to emit UI shapes.
- **Implementation:**
  - Purge presentation schemas from `src/contracts/wire-lifecycle.ts`.
  - Update `durable-event-adapter.ts` and `delta-translator.ts`.
  - Ensure all files < 200 LOC.
- **Verification:** `node --test tests/wire-contract-purity.test.ts` and `npm run test:contracts` PASS.
- **Stop condition:** Any UI presentation schema surviving in `src/contracts/`.

---

### Slice 3: Subagent Process Spawner Inversion (AP-010, AP-012)
- **Boundary:** Subagent Orchestration & Process Lifecycle
- **AP gates:** AP-010, AP-012, AP-016
- **Files:**
  - Create: `src/runner/ports/subagent-spawner.ts` (Interface `ISubagentProcessSpawner`).
  - Create: `src/runner/adapters/native-subagent-spawner.ts` (Autonomous in-process / Node.js worker spawner).
  - Modify: `src/host/subthread-spawner.ts` (Implements `ISubagentProcessSpawner` for BB via `bb thread spawn`).
  - Modify: `src/shared/subagent-envelope.ts` (Standardize to neutral protocol envelope `[durable:subagent:v1 session=... conv=...]`).
  - Modify: `src/runner/subagent.ts` (Inject spawner port into subagent tool).
  - Test: `tests/subagent-spawner-port.test.ts`
- **Red test first:**
  - Assert `NativeSubagentSpawner` launches child conversations headlessly without `bb` CLI.
  - Assert protocol envelope uses neutral format `[durable:subagent:v1 ...]`.
  - Assert `BbSubthreadSpawner` conforms to `ISubagentProcessSpawner`.
- **Implementation:**
  - Define spawner interface.
  - Implement native and BB adapters.
  - Update envelope parsing and formatting.
  - Ensure all files < 150 LOC.
- **Verification:** `node --test tests/subagent-spawner-port.test.ts` PASS.
- **Stop condition:** Hardcoded calls to `bb` binary inside runner core.

---

### Slice 4: Strategy-Driven Extension Assembly (AP-010, AP-020)
- **Boundary:** Plugin Architecture & Composition Root
- **AP gates:** AP-010, AP-019, AP-020
- **Files:**
  - Modify: `src/runner/extension-mount.ts` (Refactor to iterate `DurablePluginRegistry.listPlugins()` dynamically).
  - Modify: `src/runner/plugins/built-in/coding-tools.ts`
  - Modify: `src/runner/plugins/built-in/codemode.ts`
  - Modify: `src/runner/plugins/built-in/subagents.ts`
  - Modify: `src/runner/runtime-loader.ts`
  - Test: `tests/plugin-strategy-assembly.test.ts`
- **Red test first:**
  - Assert `extension-mount.ts` contains no hardcoded static tool definitions; all extensions are mounted via `DurablePlugin` strategies.
  - Assert adding a custom plugin to `DurablePluginRegistry` automatically mounts its extensions into the harness without editing `extension-mount.ts`.
- **Implementation:**
  - Invert tool assembly through `DurablePluginContext`.
  - Ensure all files < 150 LOC.
- **Verification:** `node --test tests/plugin-strategy-assembly.test.ts` PASS.
- **Stop condition:** Any hardcoded extension or tool in `extension-mount.ts`.

---

### Slice 5: Host Reconnection, Full Verification & Release v0.4.0
- **Boundary:** System Integration & Two-Circuit Review (AP-028)
- **AP gates:** AP-010, AP-011, AP-014, AP-018, AP-019, AP-020, AP-028
- **Files:**
  - Modify: `src/host/session.ts`
  - Modify: `src/host/session-registry.ts`
  - Rebuild: `node scripts/build-runner.mjs`
  - Test: Full test suite (`npm test`, `npm run test:contracts`)
- **Verification:**
  - **Circuit 1 (Architectural Review):**
    * Zero client thread concepts in `src/runner/`.
    * Zero presentation schemas in `src/contracts/wire-*.ts`.
    * All files < 200 LOC (AP-019).
    * Target Verdict: **PASS**.
  - **Circuit 2 (Product Review):**
    * Journey 1: Standalone CLI execution without host.
    * Journey 2: BB IDE integration with 700+ passing tests.
    * Journey 3: Fail-fast error recovery on invalid inputs.
    * Target Verdict: **PASS**.
  - Rebuild runner binary and commit release.
