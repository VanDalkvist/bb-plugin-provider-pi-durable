# Architectural Decoupling Audit: Pi Durable Harness (`src/runner`) vs Beyond Boundaries (`src/host`)

**Status:** COMPLETE  
**Auditor:** Independent Software Architect  
**Target:** `bb-plugin-provider-pi-durable` (v0.4.0)  
**Verdict:** **FAIL (Architectural Coupling Persists Behind Renamed Tokens)**

---

## Executive Summary

While the recent string-replacement sweeps successfully eliminated the literal substring `"bb"` from `src/runner/` and renamed wire schemas from `BBWireEvent` to `RunnerEvent`, **the fundamental architectural coupling remains unresolved**. 

A syntactic rename is not architectural decoupling:
1. **Inverted Responsibility (Leakage of Host Topology into Domain Kernel):** The runner's SQLite storage (`session.sqlite`) and transactional documents (`durable.binding`, `durable.binding-index`) are specifically structured to store Beyond Boundaries' thread hierarchy (`threadId`, `parentThreadId`). The mapping between a client thread and an internal conversation belongs exclusively in the Host Adapter, but has been forced into the core storage schema.
2. **Presentation Leaks in Wire Contracts:** Contracts in `src/contracts/wire-*.ts` (such as `PlanStep` and `TasksSnapshotEvent`) are not engine-domain models; they are 1:1 reflections of Beyond Boundaries' Inline UI component schemas (`Plan`, `Steps`).
3. **Implicit Host Binding via Prompt Envelopes:** Subagent delegation relies on a hardcoded magic string envelope `[bb:pi-subagent-mirror:v1 session=... parent=... conv=...]` in `src/shared/subagent-envelope.ts`, and subthread spawning in `src/host/subthread-spawner.ts` shells out to the `bb` CLI (`bb thread spawn`). The runner cannot autonomously orchestrate external processes outside of Beyond Boundaries.
4. **Absence of Port/Repository Abstractions:** Inbound command handlers (`binding-commands.ts`, `session-commands.ts`) operate directly on low-level storage transactions (`harness.commit(async (tx) => { ... })`) and low-level document revisions rather than going through clean Domain Services or Repositories.

---

## 1. Architectural Topology: Current vs Target Hexagonal Architecture

### Current As-Is State (Entangled Hexagon)

```
+-----------------------------------------------------------------------------------+
| Beyond Boundaries IDE (UI & Daemon)                                               |
+-----------------------------------------------------------------------------------+
                                   | (JSON-RPC)
                                   v
+-----------------------------------------------------------------------------------+
| Host Adapter (`src/host/`)                                                        |
| - `SessionRegistry` (manages thread-to-session routing)                           |
| - `SubthreadSpawner` (executes `bb thread spawn` via CLI)                         |
| - `DeltaTranslator` (translates RunnerEvent -> BB UI deltas)                      |
| - `DurableBindingManager` (reads & writes thread bindings via runner RPC)         |
+-----------------------------------------------------------------------------------+
                                   | (JSONL over stdin/stdout)
                                   v
+-----------------------------------------------------------------------------------+
| Runner Kernel (`src/runner/`)                                                     |
| - Driving commands explicitly take `threadId`, `parentThreadId`                   |
| - Document `durable.binding` persists BB thread IDs into SQLite                   |
| - Wire contracts (`wire-lifecycle.ts`) mirror BB Inline UI components             |
| - Subagent delegation mirrors BB thread envelopes                                 |
+-----------------------------------------------------------------------------------+
```

### Target To-Be State (True Hexagonal / Clean Architecture)

```
               [ CLI Driving Adapter ]     [ Web / Telegram Adapter ]    [ BB IDE Adapter ]
                         \                         |                        /
                          \                        |                       /
                           v                       v                      v
        +----------------------------------------------------------------------------+
        | Inbound Ports (Application API):                                           |
        | - `IConversationService` (create, prompt, steer, abort)                   |
        | - `ISubagentOrchestrator` (delegate, report, status)                       |
        | - `IModelConfigurationService` (policy, thinking, quota)                   |
        +----------------------------------------------------------------------------+
                                               |
                                               v
        +----------------------------------------------------------------------------+
        | Core Domain (Pure Pi Durable Engine):                                      |
        | - Entities: Conversation, Turn, Entry, Task, Tool                          |
        | - Value Objects: MessageContent, UsageStats, ToolCall                      |
        | - Domain Events: TurnStarted, DeltaEmitted, ToolExecuted, TurnFinished      |
        +----------------------------------------------------------------------------+
                                               |
                                               v
        +----------------------------------------------------------------------------+
        | Outbound Ports (Driven Interfaces):                                        |
        | - `ISessionStorage` (SQLite WAL repository)                                |
        | - `IEventSink` (observable domain event stream)                            |
        | - `IProcessSpawner` (autonomous process / worker launcher)                 |
        | - `IPluginRegistry` (extensible tool & extension strategies)               |
        +----------------------------------------------------------------------------+
                               /                       \                      \
                              v                         v                      v
                   [ SQLite Storage Adapter ]    [ Local Subagent Worker ]  [ Plugins ]
```

---

## 2. Detailed Findings

### [P1] Architectural Leak: Client Thread IDs Persisted in Core Storage
- **Location:** `src/runner/binding-docs.ts:13-33`, `src/runner/binding-commands.ts:15-55`
- **Violation:** Dependency Inversion Principle (DIP), Single Responsibility Principle (SRP).
- **Evidence:**
  ```ts
  export interface StoredBinding {
      readonly providerId: string;
      readonly sessionId: string;
      readonly conversationId: ConversationId;
      readonly threadId: string;
      readonly parentThreadId: string | null;
      readonly createdAt: number;
  }
  ```
- **Impact:** An autonomous computing engine should only know about its own internal hierarchy: `SessionId`, `ConversationId`, and `TaskId`. Forcing the engine's SQLite database to store `threadId` and `parentThreadId` (the client's UI thread identifiers) means the storage schema cannot be reused by any other consumer (e.g., a CLI, a web app, or a Telegram bot) without inventing dummy "threads".
- **Fix:** Move the thread-to-conversation mapping table entirely into the Host layer (`src/host/` or host SQLite/metadata). The runner should strictly receive and return `conversationId`.

---

### [P1] Presentation Leak: Wire Contracts Mirror BB Inline UI Schema
- **Location:** `src/contracts/wire-lifecycle.ts:6-14`
- **Violation:** Ports & Adapters, Separation of Concerns.
- **Evidence:**
  ```ts
  export const planStepSchema = z.object({
      step: z.string(),
      status: z.enum(["pending", "active", "completed", "failed"]),
  }).passthrough();
  export type PlanStep = z.infer<typeof planStepSchema>;

  export const tasksSnapshotSchema = wireContextSchema.extend({
      type: z.literal("tasks_snapshot"),
      steps: z.array(planStepSchema)
  });
  ```
- **Impact:** `tasks_snapshot` and `PlanStep` were designed specifically to satisfy the Beyond Boundaries Inline UI `Plan` component (`status: "pending" | "active" | "completed" | "failed"`). The core engine produces hierarchical `Task` states and `RuntimeGraphSnapshot`. Pushing flattened UI presentation cards into the wire protocol violates the principle that the core engine produces domain events, while the host presentation adapter formats UI representations.
- **Fix:** The engine wire protocol should emit only pure domain events (`task_state_changed`, `runtime_graph_snapshot`). The translation to `PlanStep` / `tasks_snapshot` belongs strictly in `src/host/delta-translator.ts`.

---

### [P1] Broken Inversion of Control: Subthread Spawning Hard-Coupled to `bb` CLI
- **Location:** `src/host/subthread-spawner.ts:98-142`, `src/shared/subagent-envelope.ts:21-25`
- **Violation:** Dependency Inversion Principle (DIP), Open-Closed Principle (OCP).
- **Evidence:**
  ```ts
  const cliBinary = process.env.BB_CLI || "bb";
  const res = await execFileAsync(cliBinary, cliArgs, ...);
  ```
  And the envelope header:
  ```ts
  const RESERVED_PREFIX = "[bb:pi-subagent-mirror:";
  ```
- **Impact:** If `src/runner` is run headlessly on a Linux machine without `bb` installed, delegating to subagents fails or falls back to single-process background tasks because process spawning is hardwired to Beyond Boundaries' proprietary CLI command `bb thread spawn`. Furthermore, prompts are tainted with `[bb:pi-subagent-mirror:v1...]`.
- **Fix:** Abstract child process/worker spawning behind an `ISubagentSpawner` port. Provide a `NativeProcessSpawner` (for autonomous CLI/headless) and a `BbThreadSpawner` (for BB IDE). Replace the proprietary `[bb:...]` prompt prefix with a standard protocol metadata envelope or native FSM context.

---

### [P2] Missing Repository Pattern: Raw Transaction Logic in Command Handlers
- **Location:** `src/runner/binding-commands.ts:32-48`, `src/runner/session-commands.ts:18-85`
- **Violation:** Separation of Concerns, Information Hiding (GoF Repository Pattern).
- **Evidence:**
  Command dispatchers directly invoke:
  ```ts
  await durable.harness.commit(async (tx) => {
      const index = await tx.doc(BindingIndexDoc);
      const state = await tx.doc(BindingDoc, convId);
      ...
  });
  ```
- **Impact:** High coupling between the transport layer (JSONL command dispatch) and the storage engine (`@earendil-works/pi-durable` transactional documents). Any change in document schema or persistence strategy requires editing network command handlers.
- **Fix:** Introduce proper Application Services or Repositories (e.g. `BindingRepository`, `SessionStatsService`) that hide `harness.commit` and `tx.doc` behind clean method calls (`bindingRepo.bind(conversationId, clientRef)`).

---

### [P2] Incomplete Strategy Pattern in Plugin Architecture
- **Location:** `src/runner/plugins/registry.ts`, `src/runner/extension-mount.ts`
- **Violation:** Open-Closed Principle (OCP), Strategy Pattern.
- **Evidence:** While `DurablePluginRegistry` exists, `src/runner/extension-mount.ts` still manually and monolithically wires `createCodingTools`, `createCodemodeExtension`, and Pi agent settings rather than delegating tool assembly entirely to registered plugins.
- **Impact:** New tools or extensions cannot be plugged into the harness dynamically without modifying `extension-mount.ts`.
- **Fix:** Complete the inversion: `extension-mount.ts` should iterate over `pluginRegistry.listPlugins()` and let each plugin mount its extensions into the Durable harness during startup.

---

## 3. Autonomous Headless Feasibility Matrix

| Capability | Autonomous Headless | BB-Coupled Host | Current Obstacle |
|---|---|---|---|
| Single Turn Prompting | **YES** | YES | None; clean CLI RPC works. |
| Tool Execution (Bash, FS) | **YES** | YES | Works standalone via `@earendil-works/pi-durable`. |
| Subagents (In-Process) | **YES** | YES | Works in-process via `SubagentsDoc`. |
| Subagents (External Mirror) | **NO** | YES | **Blocked**: Requires `bb thread spawn` and `bb.db`. |
| Session Identity & Resume | **PARTIAL** | YES | **Blocked**: Stores `threadId` in SQLite WAL instead of pure client keys. |
| UI Presentation | **N/A** | YES | Wire protocol still carries UI cards (`PlanStep`). |

---

## 4. Refactoring Roadmap for True Architectural Decoupling

### Phase 1: Storage & Identity Inversion (Purge Client Threads from Kernel)
- Remove `durable.binding` and `durable.binding-index` from `src/runner/`.
- Shift thread-to-conversation mapping into `src/host/session-binding-store.ts` (persisting to a separate host sidecar file or host DB).
- Runner API becomes purely: `prompt(conversationId, ...)`, `createConversation()`, `abort(conversationId)`.

### Phase 2: Wire Contract Purification (Hexagonal Domain Events)
- Deprecate `tasks_snapshot` in `src/contracts/wire-lifecycle.ts`.
- Standardize on `runtime_graph_snapshot` and granular domain events (`task_updated`, `subagent_state_changed`).
- Keep all UI card structuring (`PlanStep`, Inline UI formatting) strictly inside `src/host/delta-translator.ts`.

### Phase 3: Pluggable Spawner Port (Abstracting `bb thread spawn`)
- Define `ISubagentProcessSpawner` interface in `src/runner/ports/spawner.ts`.
- In `src/host/`: implement `BbCliSubagentSpawner` using `bb thread spawn`.
- In `src/runner/`: implement `HeadlessWorkerSpawner` using standard Node.js `child_process.fork()` or worker threads.
- Replace `[bb:pi-subagent-mirror:v1...]` envelope with an engine-native envelope: `[durable:subagent:v1 session=... conv=...]`.

### Phase 4: Strategy-Driven Extension Assembly
- Refactor `extension-mount.ts` to be 100% data-driven from `DurablePluginRegistry`.
- Built-in plugins (`coding-tools`, `codemode`, `subagents`) configure their extensions autonomously.

---

## 5. Architectural Verdict

### **VERDICT: FAIL**

**Justification:**  
Removing the string `"bb"` while keeping client thread IDs in the runner's SQLite schema, mirroring BB Inline UI component shapes in the wire protocol, hardcoding `[bb:pi-subagent-mirror:...]` envelopes, and relying on `bb thread spawn` for subagent execution is **cosmetic decoupling, not architectural decoupling**. 

The runner cannot currently operate as an independent sovereign agent engine without Beyond Boundaries infrastructure. The 4 findings above (P1/P2) must be resolved according to the roadmap to achieve true Clean Architecture.
