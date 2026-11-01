# Architectural Decoupling Audit: Pi Durable Harness (`src/runner`) vs Beyond Boundaries (`src/host`)

**Status:** COMPLETE (Cycle 99 Architectural Audit)  
**Auditor:** Independent Senior Software Architect  
**Target:** `bb-plugin-provider-pi-durable` (v0.3.29 / v0.4.0-candidate)  
**Date:** 2026-11-01  
**Verdict:** **VERDICT: FAIL** (Critical Architectural Coupling, DIP Violations, and Host Protocol Bleed)

---

## Executive Summary

A comprehensive architectural audit of `/Users/vanya/Projects/bb-plugin-provider-pi-durable` was conducted to evaluate the decoupling between the Pi Durable engine harness (`src/runner`) and the Beyond Boundaries IDE host integration (`src/host`).

While prior refactoring iterations (Cycles 61–72, 90–98) eliminated literal `"bb"` naming artifacts from `src/runner/` and renamed wire schemas from `BBWireEvent` to `RunnerEvent`, **the fundamental architectural coupling remains deeply embedded across storage, protocols, and execution lifecycles**:

1. **Host Topology Infiltrates Core SQLite Storage (`AP-010`, `AP-020`):** The runner's internal SQLite documents (`durable.binding`, `durable.binding-index`) and command handlers (`binding-commands.ts`) explicitly store and index Beyond Boundaries UI thread identifiers (`threadId`, `parentThreadId`). The core engine's subagent discovery logic (`subagent-watcher.ts`) is coupled to querying this host thread index on startup.
2. **Host Bypasses Runner Boundary via Raw SQLite Access (`AP-010`, `AP-016`):** The host adapter (`durable-binding-store.ts`) uses `node:sqlite` `DatabaseSync` to directly read the runner's private `session.sqlite` database file, running raw SQL queries against internal `@earendil-works/pi-durable` revision tables (`documents`, `document_revisions`).
3. **Transport Protocol Bleed via Out-of-Band File Descriptors 3 & 4 (`AP-021`, `AP-027`):** The runner hardcodes an out-of-band IPC channel on FD 3 (`CHILD_TO_BRIDGE_FD = 3`) and FD 4 (`BRIDGE_TO_CHILD_FD = 4`). Crucially, **the engine's `ready` signal is emitted exclusively over FD 3**; running the runner as a standard POSIX process (stdin/stdout/stderr) produces `ENXIO` errors and leaves headless consumers permanently blocked waiting for readiness.
4. **Host Presentation Bleed in Contracts & FSM Logic (`AP-011`, `AP-026`):** 
   - Wire contracts retain dead BB Inline UI artifacts (`planStepSchema` and `tasks_snapshot` in `wire-lifecycle.ts`).
   - Subagent task naming in `subagent.ts` and `subagent-delivery.ts` explicitly truncates task names to accommodate BB Core's internal SQLite column constraint (`threads.title <= 500 chars` via `nativeChildTitle`).
5. **Orphaned Strategy/Plugin Architecture (`AP-014`, `AP-018`):** The declared `DurablePluginRegistry` in `src/runner/plugins/` is completely dead code; the harness hardcodes all tool and extension registrations in `harness-setup.ts`, providing a false facade of extensibility.
6. **Incomplete In-Process Engine Facade (`AP-011`, `AP-020`):** `openDurable()` in `src/runner/runtime.ts` does not wire the event stream adapter, subagent watcher, or runtime graph source, making headless library integration impossible without duplicating 50 lines of script wiring from `src/runner/index.ts`.

---

## 1. Architectural Topology: As-Is vs To-Be Hexagonal Architecture

### Current As-Is Topology (Entangled Hexagon)

```
+-----------------------------------------------------------------------------------------------------+
| BEYOND BOUNDARIES IDE (Desktop Shell, Host Daemon & UI Workspace)                                  |
+-----------------------------------------------------------------------------------------------------+
                                            | (BB JSON-RPC: thread/start, thread/delta)
                                            v
+-----------------------------------------------------------------------------------------------------+
| HOST ADAPTER LAYER (`src/host/`)                                                                    |
|  - Bridge Router (`bridge-router.ts`)                                                               |
|  - Delta Translator (`delta-translator.ts`, `tool-delta-translator.ts`)                             |
|  - Subthread Spawner: Shells out to `bb thread spawn` CLI with `[bb:pi-subagent-mirror:v1 ...]`       |
|  - Direct SQLite Snoop: `DurableBindingManager` reads `session.sqlite` directly via raw SQL!         |
+-----------------------------------------------------------------------------------------------------+
         | (stdio: stdin/stdout JSONL)                        | (Out-of-band FD 3 / FD 4 IPC)
         v                                                    v
+-----------------------------------------------------------------------------------------------------+
| RUNNER HARNESS LAYER (`src/runner/`)                                                                |
|  - `index.ts`: Hardcodes FD 3/4 bridge channels; ready signal ONLY emitted on FD 3!                 |
|  - `session-commands.ts`: Accepts `threadId` and `parentThreadId` on `RunnerCommandPayload`         |
|  - `binding-commands.ts` & `binding-docs.ts`: Persists BB thread hierarchy to SQLite docs           |
|  - `subagent.ts`: Truncates task titles for BB `threads.title` column limit via `nativeChildTitle`  |
|  - `subagent-watcher.ts`: Discovers child conversations by reading `BindingIndexDoc.byThreadId`     |
|  - `plugins/`: Orphaned registry; `harness-setup.ts` hardcodes tool setup                           |
+-----------------------------------------------------------------------------------------------------+
                                            |
                                            v
+-----------------------------------------------------------------------------------------------------+
| PI DURABLE CORE (`@earendil-works/pi-durable`) & PI CODING AGENT (`@earendil-works/pi-coding-agent`)|
|  - Harness, TaskGraph, FSM Engine, SQLite WAL, LiveDoc, Extensions, Tool Definitions                |
+-----------------------------------------------------------------------------------------------------+
```

### Target To-Be Topology (Strict Hexagonal Architecture & Ports/Adapters)

```
       [ BB IDE Host Adapter ]        [ Headless CLI Adapter ]        [ Telegram / Web Adapter ]
       (`src/host/`)                  (`src/cli/`)                    (External UI Consumers)
                 \                               |                               /
                  \                              |                              /
                   +-----------------------------+-----------------------------+
                                                 |
                                                 v (Pure Domain DTOs / Inbound Port)
        +-------------------------------------------------------------------------------+
        | INBOUND PRIMARY PORTS (Driving Ports):                                        |
        |  - `IConversationPort`: `prompt()`, `steer()`, `abort()`, `compact()`          |
        |  - `ISessionManagementPort`: `openSession()`, `listConversations()`, `stats()`|
        |  - `IModelConfigurationPort`: `setModel()`, `setThinking()`, `setPolicy()`    |
        +-------------------------------------------------------------------------------+
                                                 |
                                                 v
        +-------------------------------------------------------------------------------+
        | APPLICATION & DOMAIN CORE (`src/runner/core/`):                               |
        |  - `DurableEngine`: Unified cohesive Facade                                   |
        |  - Entities: `Conversation`, `Turn`, `TaskRecord`, `SubagentSession`          |
        |  - Value Objects: `ConversationId`, `TaskId`, `ModelRef`, `UsageMetrics`      |
        |  - Zero knowledge of external UI threads, BB envelopes, or DB column limits   |
        +-------------------------------------------------------------------------------+
                                                 |
                                                 v (Driven Interfaces / Outbound Ports)
        +-------------------------------------------------------------------------------+
        | OUTBOUND SECONDARY PORTS (Driven Ports):                                      |
        |  - `IEventSink`: Observable canonical stream (`RunnerEvent` domain events)    |
        |  - `IStoragePort`: Abstract session storage (Implemented via Pi SQLite)       |
        |  - `ISubagentProcessSpawner`: Pluggable child process / worker launcher       |
        |  - `IPluginRegistry`: Dynamic Strategy-based tool & extension assembly        |
        +-------------------------------------------------------------------------------+
                 /                               |                               \
                /                                |                                \
               v                                 v                                 v
    [ Pi SQLite Adapter ]             [ Spawner Implementations ]          [ Active Plugins ]
    (`session.sqlite` WAL)            - `InProcessSpawner` (Default)       - `CodingToolsPlugin`
                                      - `ForkWorkerSpawner` (Headless)     - `CodemodePlugin`
                                      - `BbSubthreadSpawner` (BB Host)     - `SubagentPlugin`
```

---

## 2. Deep-Dive Audit across the 5 Target Dimensions

### 2.1. Dependency Inversion Principle (DIP) & Boundary Integrity
- **DIP Violation:** Higher-level domain orchestration in `src/runner/` depends directly on Beyond Boundaries host expectations instead of depending on abstractions.
- **Evidence:**
  - `src/runner/binding-docs.ts:3-10`: `StoredBinding` declares `threadId: string`, `parentThreadId: string | null`, and `providerId: string`.
  - `src/runner/binding-commands.ts:28-57`: The runner's command dispatcher parses `threadId` and `parentThreadId` and commits them to the internal SQLite document `BindingDoc` and index `BindingIndexDoc`.
  - `src/contracts/runner-command.ts:18-19`: The command wire schema carries `threadId` and `parentThreadId`.
  - `src/runner/subagent-watcher.ts:94-102`: Child conversation discovery relies on scanning `BindingIndexDoc.byThreadId`.
- **Architectural Analysis:** In Pi Durable, the unit of execution is a `Conversation` (identified by integer/string `ConversationId`) managed under `Harness`. The notion of a "thread" belongs entirely to Beyond Boundaries' IDE workspace (`thr_...`). By persisting BB thread IDs inside the SQLite document database of the engine, the runner violates DIP: the engine kernel knows about its presentation host's database schema.

### 2.2. Ports & Adapters (Hexagonal Architecture)
- **Driving Ports (Inbound):**
  - Stdio JSON-RPC: `src/runner/index.ts` attaches `attachJsonlLineReader(process.stdin, ...)`.
  - Sideband IPC: `src/runner/bridge-channel.ts` listens on FD 4 (`BRIDGE_TO_CHILD_FD = 4`).
  - Filesystem Watcher: `src/runner/control-channel.ts` watches `sessionDir/control.jsonl` for `abort_task`.
  - Library API: `src/runner/runtime.ts` exports `openDurable()`.
- **Driven Ports (Outbound):**
  - Storage: Hardcoded to `openNodeSqliteStorage` in `runtime-loader.ts`. No abstract repository port.
  - Event Dispatch: Hardcoded to `writeWireStdout` on stdout and `writeSync(3)` on FD 3.
  - Subagent Worker Spawning: Inverted — the host adapter (`subthread-spawner.ts`) intercepts subagents and spawns BB threads via `bb thread spawn`, while the runner has no pluggable `ISubagentSpawner` port.
- **Boundary Violation:** Adapters are NOT cleanly isolated. The host adapter (`durable-binding-store.ts:101-135`) directly opens the runner's private `session.sqlite` database using `node:sqlite` `DatabaseSync`, executing raw SQL against internal Pi Durable document tables.

### 2.3. Data Leaks & Structural Coupling in Contracts
- **Dead Presentation Schemas in Engine Wire:** `src/contracts/wire-lifecycle.ts:6-14` defines `planStepSchema` and `tasksSnapshotSchema` (`steps: z.array(planStepSchema)`).
  - This schema was created 1:1 to feed Beyond Boundaries' Inline UI `Plan` component (`planSteps` channel).
  - As confirmed by `src/host/delta-translator.ts:145`, synchronization of `tasks_snapshot` was discontinued in favor of the `runtime-graph`.
  - Yet `tasks_snapshot` and `PlanStep` remain in `wire-lifecycle.ts` and are re-exported in `src/runner/bridge/contracts.ts:5`, polluting the domain wire contract with dead UI representations.
- **Domain Metadata Bleed:** `src/shared/child-title.ts` is explicitly documented as:
  ```ts
  /**
   * Sanitizes and bounds subagent thread titles for Beyond Boundaries Core.
   * Protects Core's 500-char column limit in threads.title (<= 494 UTF-16 units).
   */
  ```
  This sanitization logic is imported directly into `src/runner/subagent.ts:12` and `src/runner/subagent-delivery.ts:5`. The core engine truncates its internal subagent task names specifically to avoid crashing BB Core's SQLite table column!

### 2.4. GoF Design Patterns Analysis
- **Adapter Pattern:**
  - Event hierarchy: `AgentEvent` (Pi Durable) -> `RunnerEvent` (`DurableEventAdapter`) -> `ThreadDelta` (`DeltaTranslator`).
  - Tool hierarchy: Pi Coding Agent `ToolDefinition` -> Pi Durable `ToolRegistration` (`adaptExtensionTool`).
  - *Defect:* While `DeltaTranslator` cleanly converts `RunnerEvent` to `ThreadDelta`, the sideband IPC channel (`bridge-channel.ts`) on FD 3/4 completely circumvents the Adapter pattern, sending unadapted out-of-band JSON frames directly between host and runner.
- **Strategy / Factory Pattern:**
  - `src/runner/plugins/` defines `DurablePlugin` and `DurablePluginRegistry`.
  - *Defect (Orphaned Strategy):* `DurablePluginRegistry` is never used by the runtime engine! `harness-setup.ts:70-101` (`createCodingRegistry`) hardcodes all tool installations directly. New tools or extensions cannot be plugged in without modifying `harness-setup.ts`.
- **Repository / Unit of Work Pattern:**
  - Storage operations in `binding-commands.ts` and `session-commands.ts` execute raw `harness.commit(async (tx) => { ... })` and `tx.doc(...)`.
  - There is no Repository layer isolating the application commands from Pi Durable's document schema.
  - In `src/host/durable-binding-store.ts`, the host runs raw SQL queries against `session.sqlite`, totally violating information hiding and Repository abstractions.

### 2.5. Headless & Autonomous Sovereignty Test
Empirical testing was executed directly against `dist/runner/index.js`:

```bash
# Test 1: Version inquiry
$ node dist/runner/index.js --version
1.4.0   # [PASS]

# Test 2: Standard POSIX Stdio JSON-RPC invocation
$ echo '{"type":"get_available_models","id":"1"}' | node dist/runner/index.js --no-session
[BridgeChannel] FD 3 write warning: ENXIO: no such device or address, write
[BridgeChannel] FD 3 write warning: ENXIO: no such device or address, write
{"id":"1","type":"response","command":"get_available_models","success":true,"data":{...}}
```

**Sovereignty Test Verdict: FAIL.**
1. **The FD 3 / FD 4 Deadlock:**
   - In `src/runner/index.ts:163`, the runner emits `{ ready: true, kind: "ready" }` exclusively to `sendToBridge()` (FD 3).
   - In standard stdout, **no readiness notification is ever emitted**. A headless orchestrator connecting to stdin/stdout will hang indefinitely waiting for a ready signal unless it synthesizes a 5-stream stdio file descriptor array.
2. **Missing In-Process Facade:**
   - Calling `openDurable()` from `src/runner/runtime.ts` does not attach `DurableEventAdapter`, `startSubagentWatcher`, or `RuntimeGraphSource`. A developer attempting to consume `src/runner` as an npm package in another UI receives an engine without streaming, without subagent observation, and without graph telemetry.

---

## 3. Detailed Ranked Findings (AP Rules & Finding Format)

### [P1] Host Thread Hierarchy Infiltrates Core SQLite Storage & Command Protocol
- **Evidence:** 
  - `src/runner/binding-docs.ts:3-10` (`StoredBinding.threadId`, `parentThreadId`).
  - `src/runner/binding-commands.ts:28-57` (`register_binding` command handler).
  - `src/contracts/runner-command.ts:18-19` (`runnerCommandSchema.threadId`, `parentThreadId`).
  - `src/runner/subagent-watcher.ts:94-102` (Discovery iterates over `BindingIndexDoc.byThreadId`).
- **Impact:** The runner's SQLite storage is contaminated with Beyond Boundaries client UI thread keys. The engine cannot be embedded in any other UI or client (Web, Telegram, CLI) without inventing dummy BB thread IDs. Subagent discovery breaks if bindings are not registered by BB.
- **Rule:** `AP-010` (Modular Monolith + Ports & Adapters), `AP-011` (Low Coupling), `AP-020` (Clean Architecture Boundaries), `AP-026` (API Contracts and DTO Boundaries).
- **Fix decision:** `fix-now` (Plan Phase 1).

---

### [P1] Host Directly Inspects Runner SQLite Database via Raw SQL (Storage Port Bypass)
- **Evidence:** 
  - `src/host/durable-binding-store.ts:101-135`: `DurableBindingManager.readOfflineBindings()` opens `session.sqlite` via `node:sqlite` `DatabaseSync` and runs:
    ```sql
    SELECT r.content FROM documents d JOIN document_revisions r ON d.id = r.document_id WHERE d.kind IN ('durable.binding', '"durable.binding"') AND d.retired_at IS NULL ORDER BY r.seq DESC
    ```
- **Impact:** Total violation of encapsulation and process isolation. The host relies on the internal table structure (`documents`, `document_revisions`) of `@earendil-works/pi-durable`. Any internal schema evolution in the upstream storage engine silently breaks the host's offline binding recovery.
- **Rule:** `AP-010` (Ports & Adapters), `AP-016` (Trusted Security Boundary), `AP-020` (Clean Architecture Boundaries).
- **Fix decision:** `fix-now` (Plan Phase 1).

---

### [P1] Transport Leak via Out-of-Band File Descriptors 3 & 4 (Sideband IPC)
- **Evidence:** 
  - `src/runner/bridge-channel.ts:5-6` (Hardcoded `CHILD_TO_BRIDGE_FD = 3`, `BRIDGE_TO_CHILD_FD = 4`).
  - `src/runner/index.ts:42, 54, 163` (`sendToBridge` writes to FD 3; `ready` is emitted ONLY on FD 3).
  - `src/host/runner-process.ts:38` (Spawns runner with `stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"]`).
  - Direct execution test confirms `ENXIO: no such device or address, write` when executed in standard POSIX environments.
- **Impact:** The runner cannot operate as a standard CLI tool or subprocess without generating I/O errors. Headless orchestrators cannot detect engine readiness via stdout. Model scope updates bypass the primary protocol.
- **Rule:** `AP-010` (Ports & Adapters), `AP-021` (Thin Entry Points), `AP-027` (Configuration and Environment Fail-Fast).
- **Fix decision:** `fix-now` (Plan Phase 2).

---

### [P1] Host SQL Column Limit Bleed into Engine Subagent Task Naming
- **Evidence:** 
  - `src/shared/child-title.ts:1-12`: Sanitizes and bounds subagent titles specifically for BB Core's 500-char `threads.title` column.
  - `src/runner/subagent.ts:12, 83`: Sets `name: nativeChildTitle(args.task, "worker")`.
  - `src/runner/subagent-delivery.ts:5, 36`: Sets `name: nativeChildTitle(task.input.task, "worker")`.
- **Impact:** Domain logic inside the runner truncates and sanitizes task descriptions to satisfy the storage limits of an external client application. An autonomous engine must preserve full task titles; host-specific sanitization belongs in the host adapter.
- **Rule:** `AP-011` (High Cohesion / Low Coupling), `AP-018` (Single Responsibility), `AP-020` (Clean Architecture Boundaries).
- **Fix decision:** `fix-now` (Plan Phase 1).

---

### [P2] Dead Contract Weight and Host Inline UI Bleed in `wire-lifecycle.ts`
- **Evidence:** 
  - `src/contracts/wire-lifecycle.ts:6-14`: Defines `planStepSchema` and `tasksSnapshotSchema`.
  - `src/runner/bridge/contracts.ts:5`: Re-exports `PlanStep` and `TasksSnapshotEvent`.
  - `src/host/delta-translator.ts:145`: Notes that `tasks_snapshot` was discontinued in favor of the runtime graph.
- **Impact:** Pollutes domain wire schemas with legacy Beyond Boundaries Inline UI representations (`PlanStep` matches BB's `Plan` component).
- **Rule:** `AP-015` (YAGNI), `AP-026` (API Contracts and DTO Boundaries).
- **Fix decision:** `fix-now` (Plan Phase 2).

---

### [P2] Orphaned Plugin Architecture (Fake Strategy / Factory)
- **Evidence:** 
  - `src/runner/plugins/types.ts` and `src/runner/plugins/registry.ts` define `DurablePlugin` and `DurablePluginRegistry`.
  - `src/runner/harness-setup.ts:70-101`: `createCodingRegistry` never uses the registry; it hardcodes all tool and extension installations directly.
  - `DurablePluginRegistry` is never instantiated outside of its unit tests (`tests/plugin-registry.test.ts`).
- **Impact:** Violates the Open-Closed Principle. New capabilities cannot be plugged in dynamically; developers are forced to modify `harness-setup.ts`.
- **Rule:** `AP-014` (SOLID / Clean Code), `AP-018` (Clarity and Single Responsibility).
- **Fix decision:** `log-only` (Plan Phase 4).

---

### [P2] Incomplete In-Process Engine Facade for Headless Library Consumers
- **Evidence:** 
  - `src/runner/runtime.ts:openDurable()` initializes Harness and Controller, but omits `DurableEventAdapter`, `startSubagentWatcher`, and `RuntimeGraphSource`.
  - These critical subsystems are manually instantiated only in `src/runner/index.ts:128-146`.
- **Impact:** Consumers cannot import and use `src/runner` as an in-process TypeScript library without manually recreating 50 lines of event adapter and watcher plumbing.
- **Rule:** `AP-011` (High Cohesion), `AP-020` (Clean Architecture Composition Root).
- **Fix decision:** `fix-now` (Plan Phase 3).

---

## 4. Actionable Refactoring Roadmap for True Architectural Sovereignty

### Phase 1: Storage & Identity Inversion (Purging Host Threads from Runner)
1. **Remove Binding Docs from Runner:** Delete `src/runner/binding-docs.ts` and `src/runner/binding-commands.ts`.
2. **Purge `threadId` from Runner Contracts:** Strip `threadId` and `parentThreadId` from `src/contracts/runner-command.ts`. The runner command protocol accepts only `conversationId` and domain metadata.
3. **Move Binding Persistence to Host:** Refactor `DurableBindingManager` in `src/host/` to store the `threadId <-> conversationId` mapping in a host-owned sidecar file (`host-bindings.json` in the session dir) or in BB's own database. Stop querying `session.sqlite` directly.
4. **Decouple Subagent Discovery:** Refactor `src/runner/subagent-watcher.ts` to discover subagent conversations strictly through `SubagentsDoc` and native Pi Durable conversation scan (`tx.scanConversations()`), eliminating all references to `byThreadId`.
5. **Relocate `nativeChildTitle`:** Move `src/shared/child-title.ts` exclusively to `src/host/subthread-spawner.ts`. Let the runner use unsanitized domain task titles in `SubagentRecord.name`.

### Phase 2: Transport & Protocol Unification (Standard POSIX Stdio)
1. **Eliminate FD 3 / FD 4 Sideband:** Deprecate `src/runner/bridge-channel.ts`. Merge all sideband messages (`model-scope`, `refresh-models`, `ready`, `leaf`) into the primary JSON-RPC protocol over `stdin`/`stdout`.
2. **Emit Ready on Stdout:** `src/runner/index.ts` must emit `{ type: "ready" }` or `{ type: "response", command: "init", success: true }` over `stdout` so any standard subprocess wrapper can detect readiness.
3. **Purge Dead Lifecycle Wire Events:** Remove `planStepSchema` and `tasksSnapshotSchema` from `src/contracts/wire-lifecycle.ts` and `src/runner/bridge/contracts.ts`.

### Phase 3: Cohesive In-Process Engine Facade
1. **Introduce `DurableEngine` Class:** Create `src/runner/engine.ts` encapsulating `openDurable()`, `DurableEventAdapter`, `startSubagentWatcher`, and `RuntimeGraphSource`.
2. **Provide Clean In-Process API:**
   ```ts
   export class DurableEngine {
     public static async open(options: EngineOptions): Promise<DurableEngine>;
     public readonly controller: DurableController;
     public readonly events: AsyncIterable<RunnerEvent>;
     public readonly graph: Observable<RuntimeGraphSnapshot>;
     public close(): Promise<void>;
   }
   ```
3. **Make `index.ts` a Thin CLI Wrapper:** `src/runner/index.ts` should simply instantiate `DurableEngine` and pipe its events to `process.stdout`.

### Phase 4: Strategy-Driven Plugin Architecture
1. **Wire `DurablePluginRegistry` into Composition Root:** In `src/runner/runtime-loader.ts` and `harness-setup.ts`, instantiate `DurablePluginRegistry`.
2. **Convert Built-In Tools to Strategy Plugins:** Let `codingToolsPlugin`, `codemodePlugin`, and `subagentsPlugin` register themselves into the registry during engine bootstrap.

---

## 5. Architecture Verification & Conformance Matrix

| Architecture Rule | Status | Justification / Notes |
|---|---|---|
| **AP-010 (Modular Monolith + Ports & Adapters)** | **FAILED** | Host directly queries runner SQLite DB; runner storage stores host UI thread IDs. |
| **AP-011 (Low Coupling & High Cohesion)** | **FAILED** | Runner subagent naming is bounded by BB Core SQL column limits (`threads.title <= 500`). |
| **AP-012 (Fail-fast & Explicit Error Contracts)** | **PASSED** | Zod schemas strictly parse runner commands; typed errors exist in `errors.ts`. |
| **AP-013 (Data Integrity)** | **PASSED** | Pi Durable ACID SQLite WAL transactions remain sound and uncorrupted. |
| **AP-014 (SOLID & Clean Code)** | **FAILED** | DIP violated (runner depends on host IDs); OCP violated (orphaned plugin registry). |
| **AP-015 (DRY, KISS, YAGNI)** | **FAILED** | Dead wire contracts (`planStepSchema`, `tasks_snapshot`) retained without purpose. |
| **AP-016 (Trusted Security Boundary)** | **FAILED** | Host bypasses runner process security boundary by opening raw SQLite file. |
| **AP-018 (Clarity & Single Responsibility)** | **FAILED** | Runner acts as both engine harness and host thread registry. |
| **AP-019 (File Line Budgets < 250 LOC)** | **PASSED** | All source files strictly comply with line limits (< 200 soft, < 250 hard limit). |
| **AP-020 (Clean Architecture & Composition Root)** | **FAILED** | Inverted dependency: Domain kernel models host presentation layer concepts. |
| **AP-021 (Thin Entry Points)** | **FAILED** | `index.ts` hardcodes complex FD 3/4 socket management and event wiring. |
| **AP-022 (Typed Errors)** | **PASSED** | Error classes (`InvalidCommandPayloadError`, `RunnerProtocolError`) properly defined. |
| **AP-023 (Async Discipline & No Floating Promises)** | **PASSED** | Promise lifecycle strictly handled; unref'd timers and graceful shutdown implemented. |
| **AP-026 (API Contracts & DTO Boundaries)** | **FAILED** | Public runner command DTOs leak host UI keys (`threadId`, `parentThreadId`). |
| **AP-027 (Configuration & Environment Fail-Fast)** | **FAILED** | Hardcoded reliance on FD 3/4 breaks execution in standard POSIX environments. |
| **AP-028 (Testing Strategy & Determinism)** | **PASSED** | Test suite runs deterministically with 705 passing tests. |
| **AP-029 (TypeScript Strictness)** | **PASSED** | Strict mode enabled, 0 compiler errors on `tsc --noEmit`. |

---

## 6. Overall Architectural Verdict

```
+-----------------------------------------------------------------------------------+
|                         OVERALL ARCHITECTURAL VERDICT                             |
|                                                                                   |
|                                     FAIL                                          |
|                                                                                   |
|  The decoupling between src/runner and src/host is incomplete and superficial.    |
|  Renaming tokens while preserving client thread persistence in SQLite storage,    |
|  raw SQL database inspection across process boundaries, and out-of-band FD 3/4   |
|  transport channels violates DIP, Ports & Adapters, and Clean Architecture.       |
+-----------------------------------------------------------------------------------+
```

**Residual Risk:**  
Until Phase 1 and Phase 2 of the Refactoring Roadmap are executed:
1. `src/runner` cannot be published or reused as an autonomous engine for non-BB applications.
2. Any upstream change to `@earendil-works/pi-durable` SQLite document revision schema will silently break `src/host/durable-binding-store.ts`.
3. Headless execution without BB's specialized 5-channel `spawn` configuration will continue to emit POSIX `ENXIO` errors and hang on readiness detection.
