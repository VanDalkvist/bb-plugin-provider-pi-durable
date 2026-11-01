# Clean Pi Durable Decoupling & Sovereign Harness Architecture (v0.4.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple the Pi Durable harness (`src/runner`) from Beyond Boundaries (BB IDE) into an autonomous, sovereign engine stored in `~/.durable/sessions/`, eradicating all silent fallback chains, swallowed exceptions (`console.warn`), and legacy backward compatibility in favor of fail-fast typed errors and a modular plugin architecture (built-in vs external).

**Architecture:** The harness becomes an autonomous computing kernel running `@earendil-works/pi-durable` 1.4 with transactional SQLite WAL storage. Core capabilities are structured as single-responsibility built-in plugins (`coding-tools`, `codemode`, `tool-search`, `subagents`, `compaction`), while specialized integrations (`antigravity`, `gbrain`, external MCPs) are isolated in `~/.durable/plugins/`. All vendor `bb.*` kinds, legacy fallback shims, and catch-and-warn heuristics are completely eliminated.

**Tech Stack:** TypeScript 5.7, Node.js 24 (`node:sqlite`), `@earendil-works/pi-durable` 1.4, Zod 3.24, Node Test Runner.

---

## 1. Implementer Orientation & Required Reading

An implementing agent dispatched to this plan **MUST** read the following canonical references before modifying any code:

1. **Pi Durable Kernel Interfaces:**
   - `~/Projects/pi/packages/durable/src/harness/harness.ts` (Core `Harness`, options, commit transactions).
   - `~/Projects/pi/packages/durable/src/documents.ts` (`defineDoc` contract: session vs conversation scopes).
   - `~/Projects/pi/packages/durable/src/tools/index.ts` (`createCodingTools`: `read`, `write`, `edit`, `bash`).
   - `~/Projects/pi/packages/durable/src/storage/sqlite/node.ts` (`openNodeSqliteStorage`: SQLite WAL engine).
2. **Current Runner Contracts & Boundaries:**
   - `src/contracts/runner-command.ts` (Inbound JSONL command schema).
   - `src/contracts/runner-event.ts` (Outbound JSONL event schema).
   - `src/runner/subagent-docs.ts` (Current `SubagentsDoc`).
   - `src/runner/binding-docs.ts` (Current `BindingDoc`).
   - `src/host/paths.ts` (Current session directory resolution).
3. **Architecture Rules Baseline:**
   - `~/Projects/arch-rules/arch-rules.md` (Specifically AP-010, AP-011, AP-012, AP-013, AP-014, AP-016, AP-018, AP-019, AP-020, AP-021, AP-022, AP-026, AP-028).

---

## 2. Architecture Context Map & Quality Invariants

```markdown
Architecture Context Map
- Stage: prod (major milestone bump: 0.3.29 → 0.4.0)
- Source docs: 
  - docs/arch-improvement/ledger.md (Cycle 97, Cycle 98)
  - docs/superpowers/specs/2026-10-07-prd-pi-durable-territory-ownership-and-decoupling.md
  - ~/Projects/arch-rules/arch-rules.md
- Critical AP gates:
  - AP-010 (Ports & Adapters): Runner is an autonomous kernel; BB host is an external presentation adapter.
  - AP-011 (Low Coupling): Zero occurrences of "bb" inside src/runner/.
  - AP-012 (Fail-Fast): No silent fallback chains; invalid inputs/configs throw typed errors immediately.
  - AP-013 (Data Integrity): SQLite transactions commit deterministically to session.sqlite.
  - AP-016 (Security): Sessions directory enforced with strict 0700 permissions.
  - AP-018 (Single Responsibility): Runner produces task state; host formats UI strings.
  - AP-019 (Line Budgets): All modified and new .ts files strictly < 200 LOC (hard limit 250).
  - AP-020 (Clean Architecture): Zero imports of @get-bb/* in src/runner/.
  - AP-022 (Typed Errors): Eradicate catch-and-warn; throw canonical DurableHarnessError subclasses.
  - AP-028 (Deterministic Testing): 100% green tests in contract, backend, and UI suites.
- Deviations: None.
- Non-goals: NO backward compatibility with 0.3.x session files. This is a breaking v0.4.0 release.
```

---

## 3. Product Verification: The Three Golden Journeys (S9b Protocol)

The implementing subagent must produce working software that passes black-box verification against these three journeys:

### Journey 1: Happy Path (Autonomous Headless Session Execution)
- **Action:** Launch the runner directly via CLI:
  `node dist/runner/index.js --mode rpc --session ~/.durable/sessions/test_sess/session.sqlite`
  Send JSONL commands:
  `{"type":"prompt","id":"req_1","message":"echo 'hello durable'","streamingBehavior":"followUp"}`
- **Verification:**
  - Runner process exits 0 on clean shutdown.
  - `session.sqlite` created under `~/.durable/sessions/test_sess/`.
  - Database schema contains only `kind = 'durable.*'`.
  - Output stream receives valid `RunnerEvent` frames (`agent_start`, `turn_start`, `tool_execution_start`, `turn_end`, `agent_end`).
  - No `console.warn`, no stack traces, no `bb.*` kinds in output.

### Journey 2: Cold-Start / Empty State (Zero-Data Directory Creation)
- **Action:** Point `DURABLE_SESSIONS_DIR` to a non-existent directory `/tmp/durable_fresh_<pid>` and initialize a session.
- **Verification:**
  - Directory is created automatically with `mode: 0o700` (`drwx------`).
  - Fresh SQLite database initialized cleanly without errors or warnings.
  - `get_all_bindings` returns `{ bindings: [] }` without crashing or throwing.

### Journey 3: Error Recovery & Adversarial Inputs (Fail-Fast Invariants)
- **Action 1 (Invalid Command):** Send command with missing required `threadId`:
  `{"type":"register_binding","id":"err_1","conversationId":2}`
  **Expected:** Immediate error response `{ id: "err_1", error: "Missing threadId or conversationId" }`. No silent fallback.
- **Action 2 (Path Traversal):** Attempt session file path traversal `../../etc/session.sqlite`.
  **Expected:** Rejection with `DurableStorageError: Path traversal rejected`.
- **Action 3 (Corrupt SQLite):** Point session to a malformed non-SQLite file.
  **Expected:** Immediate fail-fast with `StorageCorruptionError`. No silent fallback to in-memory mode or dummy session.

---

## 4. Implementation Slices & TDD Tasks

### Slice 1: Typed Error Infrastructure & Fail-Fast Handlers (AP-012, AP-022)
- **Boundary:** Domain / Error Handling
- **AP gates:** AP-012, AP-022
- **Files:**
  - Create: `src/runner/errors.ts`
  - Test: `tests/runner-errors.test.ts`
- **Red test first:**
  - `tests/runner-errors.test.ts` asserts:
    * `DurableStorageError`, `StorageCorruptionError`, `SessionNotFoundError` instantiate with typed error codes (`STORAGE_ERROR`, `STORAGE_CORRUPTED`, `SESSION_NOT_FOUND`).
    * `InvalidCommandPayloadError` captures `command` and detail with code `INVALID_COMMAND_PAYLOAD`.
    * `DurablePluginError` captures `pluginId` with code `PLUGIN_ERROR`.
    * Invariant: no generic `Error` or stringly-typed exceptions.
- **Implementation:**
  - Implement `DurableHarnessError` base class extending `Error`.
  - Implement `DurableStorageError`, `SessionNotFoundError`, `StorageCorruptionError`.
  - Implement `DurableCommandError`, `InvalidCommandPayloadError`.
  - Implement `DurablePluginError`.
  - Budget: `src/runner/errors.ts` < 80 LOC.
- **Verification:** `node --test tests/runner-errors.test.ts` PASS.
- **Stop condition:** Any untyped error throwing or swallowed exceptions.

---

### Slice 2: Storage Sovereignty & Complete Excision of `bb.*` (AP-011, AP-013, AP-020)
- **Boundary:** Storage Schema & Persistence
- **AP gates:** AP-011, AP-013, AP-020, AP-026
- **Files:**
  - Modify: `src/runner/subagent-docs.ts`
  - Modify: `src/runner/binding-docs.ts`
  - Modify: `src/runner/subagent-policy-ack.ts`
  - Modify: `src/runner/subagent-delivery.ts`
  - Modify: `src/contracts/runner-command.ts`
  - Modify: `src/runner/binding-commands.ts`
  - Test: `tests/durable-binding-store.test.ts`
  - Test: `tests/subagent-courier-delivery.test.ts`
- **Red test first:**
  - In `tests/durable-binding-store.test.ts`:
    * Assert `BindingDoc.definition.kind` is strictly `"durable.binding"`.
    * Assert `BindingIndexDoc.definition.kind` is strictly `"durable.binding-index"`.
    * Assert `identityKey` uses `threadId`.
    * Assert `handleBindingCommand` requires `cmd.threadId` and rejects missing `threadId` fail-fast (no fallback to `bbThreadId`).
  - In `tests/subagent-courier-delivery.test.ts`:
    * Assert `SubagentsDoc.definition.kind` is strictly `"durable.subagents"`.
    * Assert `Anchor.definition.name` is strictly `"durable.subagent-anchor"`.
    * Assert zero `Legacy*` tasks or tokens exist.
- **Implementation:**
  - `src/runner/subagent-docs.ts`: set `kind: "durable.subagents"`. Remove any `Legacy*` tokens.
  - `src/runner/binding-docs.ts`: set `kind: "durable.binding"`, `kind: "durable.binding-index"`. In `StoredBinding`, rename `bbThreadId` → `threadId`.
  - `src/runner/subagent-policy-ack.ts`: set `kind: "durable.subagent-policy-ack"`.
  - `src/runner/subagent-delivery.ts`: tasks `durable.subagent-anchor`, `durable.subagent-reporter`, `durable.subagent-courier`. Extension `durable.subagent-tasks`.
  - `src/contracts/runner-command.ts`: `threadId: z.string().min(1)` in `runnerCommandSchema`. Remove `bbThreadId`.
  - `src/runner/binding-commands.ts`: bind strictly to `cmd.threadId`. Missing `threadId` fails fast with `InvalidCommandPayloadError`.
  - Budget: all modified files < 150 LOC.
- **Verification:** `node --test tests/durable-binding-store.test.ts tests/subagent-courier-delivery.test.ts` PASS.
- **Stop condition:** Any lingering `bb.*` kind in storage schemas or task names.

---

### Slice 3: Sovereign Paths (`~/.durable/sessions`) with 0700 Permissions & Zero-Fallback Lookup (AP-016, AP-020)
- **Boundary:** Environment & Filesystem Configuration
- **AP gates:** AP-016, AP-020
- **Files:**
  - Modify: `src/host/paths.ts`
  - Modify: `src/host/durable-binding-store.ts`
  - Test: `tests/sovereign-paths.test.ts`
- **Red test first:**
  - `tests/sovereign-paths.test.ts` asserts:
    * `resolveSessionDir({})` returns strictly `~/.durable/sessions` (zero fallback to `~/.bb/pi-bridge-sessions`).
    * `resolveSessionDir({ DURABLE_SESSIONS_DIR: "/custom" })` returns `/custom`.
    * `resolveSessionFilePath("a/../b")` throws `DurableStorageError` (path traversal rejected).
    * `ensureSessionDirectory()` sets `mode: 0o700`.
  - `tests/durable-binding-store.test.ts` asserts:
    * `readOfflineBindings` queries strictly `WHERE d.kind IN ('durable.binding', '"durable.binding"')`.
- **Implementation:**
  - `src/host/paths.ts`: resolve default to `~/.durable/sessions`, validate path safety, enforce `0700` creation.
  - `src/host/durable-binding-store.ts`: update SQL query to strictly read `durable.binding` and parse `threadId`.
  - Budget: `src/host/paths.ts` < 150 LOC.
- **Verification:** `node --test tests/sovereign-paths.test.ts tests/durable-binding-store.test.ts` PASS.
- **Stop condition:** Any fallback to `~/.bb/pi-bridge-sessions` or permissive file creation.

---

### Slice 4: Protocol & Event Adapter Decoupling (Purge BB Wire Prefixes) (AP-014, AP-018)
- **Boundary:** Runner Protocol & Presentation Decoupling
- **AP gates:** AP-014, AP-018, AP-021
- **Files:**
  - Rename: `src/runner/bridge/bb-event-adapter.ts` → `src/runner/bridge/durable-event-adapter.ts`
  - Rename: `src/runner/bridge/bb-child-event-adapter.ts` → `src/runner/bridge/durable-child-event-adapter.ts`
  - Modify: `src/runner/bridge/contracts.ts`
  - Modify: `src/contracts/runner-event.ts`
  - Modify: `src/contracts/wire-message.ts`
  - Modify: `src/contracts/wire-lifecycle.ts`
  - Delete: `src/runner/task-graph-bridge.ts`
  - Modify: `src/runner/subagent-watcher.ts`
  - Modify: `src/runner/index.ts`
  - Modify: `src/runner/runtime-graph-mapper.ts`
  - Test: `tests/durable-event-adapter.test.ts`
- **Red test first:**
  - `tests/durable-event-adapter.test.ts` asserts:
    * `DurableEventAdapter` translates FSM events into canonical `RunnerEvent` stream.
    * No `BBWireEvent`, `BBPlanStep`, or `BBAssistantMessage` types are imported.
    * `RuntimeGraphSnapshot` emits clean topology; `tasks_snapshot` is completely removed.
- **Implementation:**
  - Rename files using git mv.
  - Update `src/contracts/runner-event.ts`: export `RunnerEvent`, `AgentStartEvent`, `TurnStartEvent`, `TurnEndEvent`.
  - Update `src/contracts/wire-message.ts`: export `AssistantMessage`, `AssistantMessageUsage`.
  - Update `src/contracts/wire-lifecycle.ts`: export `PlanStep`, `TasksSnapshotEvent`.
  - Delete `src/runner/task-graph-bridge.ts` (dead code).
  - In `src/runner/runtime-graph-mapper.ts`: clean lookup strictly for `durable.subagents` and `durable.subagent-anchor`.
  - Budget: all modified files < 200 LOC.
- **Verification:** `npm run test:contracts` and `node --test tests/durable-event-adapter.test.ts` PASS.
- **Stop condition:** Any remaining `BB*` type prefix in runner contracts.

---

### Slice 5: Modular Plugin Architecture (Built-in vs External) (AP-010, AP-014, AP-020)
- **Boundary:** Extensibility & Plugin Registry
- **AP gates:** AP-010, AP-014, AP-020
- **Files:**
  - Create: `src/runner/plugins/types.ts`
  - Create: `src/runner/plugins/registry.ts`
  - Create: `src/runner/plugins/built-in/coding-tools.ts`
  - Create: `src/runner/plugins/built-in/codemode.ts`
  - Create: `src/runner/plugins/built-in/subagents.ts`
  - Create: `src/runner/plugins/external/loader.ts`
  - Modify: `src/runner/runtime-loader.ts`
  - Test: `tests/plugin-registry.test.ts`
- **Red test first:**
  - `tests/plugin-registry.test.ts` asserts:
    * `DurablePluginRegistry` distinguishes `built-in` vs `external` plugins.
    * Duplicate plugin registration throws `DurablePluginError` (code `PLUGIN_ERROR`).
    * Built-in plugins (`coding-tools`, `codemode`, `subagents`) register tools directly into `Registry`.
    * External plugin loader discovers configurations from `~/.durable/plugins/` (isolating Antigravity and GBrain).
- **Implementation:**
  - `src/runner/plugins/types.ts`: `DurablePlugin`, `DurablePluginContext`, `PluginCategory`.
  - `src/runner/plugins/registry.ts`: plugin lifecycle manager (< 120 LOC).
  - Built-in plugins: wrap `@earendil-works/pi-durable/tools` and `@earendil-works/pi-durable/codemode`.
  - External loader: reads plugin definitions from `~/.durable/plugins/`.
  - Update `RuntimeLoader` to initialize plugins via registry.
  - Budget: all new files < 150 LOC.
- **Verification:** `node --test tests/plugin-registry.test.ts` PASS.
- **Stop condition:** Direct hardcoded external MCP/OAuth coupling in runner core.

---

### Slice 6: Host Presentation Reconnection & Two-Circuit Verification Gate (S9)
- **Boundary:** System Integration & Verification (AP-028)
- **AP gates:** AP-011, AP-019, AP-028
- **Files:**
  - Modify: `src/host/session.ts`
  - Modify: `src/host/session-registry.ts`
  - Modify: `src/host/delta-translator.ts`
  - Modify: `package.json` (bump version: `0.4.0`)
  - Modify: `package-lock.json`
- **Implementation:**
  - Connect host `Session` and `DeltaTranslator` to clean runner commands and events.
  - Bump version to `0.4.0`.
- **Verification Gate S9:**
  1. **Circuit 1: Architectural Reviewer (`arch-rules-implementation-review`)**
     - Execute audit: `grep -rn -i "bb" src/runner/`. Must be **EMPTY (0 lines)**.
     - Verify all modified files < 200 LOC (AP-019).
     - Target Verdict: **PASS**.
  2. **Circuit 2: Product Reviewer (`arch-improvement-product-review`)**
     - Execute Journey 1 (Happy Path CLI run).
     - Execute Journey 2 (Cold-start empty directory creation).
     - Execute Journey 3 (Error recovery on invalid command payload).
     - Run `npm test` + `npm run test:contracts`.
     - Target Verdict: **PASS**.
