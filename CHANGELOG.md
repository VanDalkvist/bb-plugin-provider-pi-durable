# Changelog

All notable changes to the `bb-plugin-provider-pi-durable` plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.3.15] - 2026-10-28

### Added
- **Task Token Usage in Task Graph (Cycle 84)**: Displayed token consumption for `pi.generation` and breadcrumbs (`pi.generation › tool`) directly in the task row before timing (`duration`), formatted compactly (e.g. `1.4k tok · 1.8s` or `450 tok · 820ms`).
- **Live On-The-Fly Token Streaming**: Active generation tasks reflect live token counts accumulated in `pi.live` (`generation.message.usage`) on the fly, updating synchronously with duration.
- **Detailed Token Breakdown in Details Panel**: Added a `Tokens` row in the Task Details inspector showing total tokens and breakdown (`total (in · out · reasoning · cache)`).
- **Dedicated Formatter and Extraction Modules**: Implemented `token-format.ts` and `task-tokens.ts`, strictly respecting line budget limits (< 200 LOC per AP-019) and zero-cycle DAG topology (AP-025).

---

## [0.3.14] - 2026-10-28

### Fixed
- **Subagent Active Status Bubble-Up (Cycle 83)**: Fixed false green checkmarks on running subagents. When a subagent anchor has active descendants (`hasActiveWork(item) === true`), the row displays the active running icon (`Play` / `text-blue-500`) and live ticking duration (`liveElapsed`) rather than static `1ms` and completed checkmark. Completed checkmark appears strictly after all child tasks settle.
- **Enriched Subagent Labels with Technical Prefix**: Subagent anchor nodes enrich their label to `bb.subagent-anchor · subagent: ${name}` from `SubagentsDoc`, preserving the technical prefix while presenting the human-readable subagent name.
- **Dedicated Subagent Task Box in Details**: Added a dedicated `<InfoSection label="Subagent task">` rendering the subagent's task prompt in a scrollable block (`max-h-32 font-mono whitespace-pre-wrap break-all`), keeping long prompts cleanly contained.
- **Stable Segment Layout & Fixed Details Header**: Fixed container vertical height jump by locking segment height to stable `max-h-64` regardless of selection. Bound inspector width to `w-72 max-w-[45%]` so the tree retains dominant width. Pinned Details header so scrolling inspector content never scrolls the header or close button out of view.

---

## [0.3.13] - 2026-10-28

### Fixed
- **Task Graph 1-Line Breadcrumbs for Single Tool Calls (Cycle 82)**: Resolved multi-line layout explosion where a generation with a single tool call occupied 2 to 3 lines. Generations with exactly one tool call are now flattened into clean 1-line breadcrumbs (`✓ pi.generation #67 › read: src/foo.ts`) without expand/collapse chevrons or nested rows.
- **Root-Only History Folding**: Eliminated parasitic `See more (1 completed)` buttons inside individual generation turns caused by global ID folding. History folding is now strictly enforced at the root level only (`depth === 0`), placed at the bottom of the root list when root turns exceed 5, and expands downwards cleanly.
- **Default-Collapsed Multi-Child Generations**: Multi-child generation turns ($\ge 2$ tool calls or subtasks) now default to a collapsed 1-line state (`› ✓ pi.generation #42 (2 tasks)`), expanding only when explicitly toggled or when active work is in progress.

---

## [0.3.4] - 2026-10-27

### Fixed
- **Non-Blocking Background Subagents via `Anchor` (Cycle 79 checkpoint)**: Resolved architectural defect where background subagents (`isBackground: true`) were directly owned by the caller tool task (`api.taskId`), causing Pi Durable's scheduler (§5.5 Spec) to hold the tool task in `completing` and the parent generation in `waiting`, completely freezing the parent conversation for the duration of the subagent. Implemented Pi Durable's canonical background `Anchor` task pattern (`test/examples/23-subagent-background.ts`) so the tool task and parent turn settle immediately, while preserving logical creator metadata (`ownerTaskId`) in `SubagentsDoc` and `RuntimeGraphSnapshot`. (Originally intended for 0.3.2, committed as part of current 0.3.4 checkpoint).
- **BB Core 120s Watchdog Disarm (Cycle 79 checkpoint)**: Emitted `{ kind: "turn.open" }` immediately upon input acceptance on root threads in `handleTurnStart`, disarming BB Core's 120s watchdog timer (`p.delete(threadId)`) and preventing false `provider_turn_start_timeout` system errors when long-running background tasks are active.

---

## [0.3.3] - 2026-10-27

### Added
- **English Plugin UI Chrome & Conditional Inspector**: Standardized all plugin-owned UI labels, titles, summaries, and counters to English. Refactored details inspector to mount conditionally only upon explicit node selection, allowing the task tree full layout width by default.
- **Truthful Live Graph Metadata (Cycle 80)**: Enriched task nodes and terminal receipts with real `toolName`, sanitized `targetHint` (redacting credentials and auth tokens), extracted model and thinking levels for generation tasks, and high-resolution start/duration timestamps.
- **Native Codemode Presentation Parity**: Adopted built-in Beyond Boundaries tool presentation for codemode execution.

---

## [0.3.1] - 2026-10-26

### Fixed
- **Runtime Graph `completing` Receipt Protocol Fault**: Resolved `INVALID_MESSAGE` runner protocol fault caused by passing raw `TaskOutcome<R>` object to `receipt.outcome` when a task transitions to `completing` state during subagent delegation. Both `terminal` and `completing` tasks now canonicalize `state.outcome.status` to `TaskOutcomeName` enum.
- **Task Graph Node State Object Handling**: Guarded `mapTaskGraphNodeState` and `taskLabel` to unwrap object outcomes safely, preventing `[object Object]` serialization in live labels.

---

## [0.3.0] - 2026-10-26

### Added
- **Pi 1.4 Foundation Upgrade**: Upgraded core Pi engine to 1.4.0 (`@earendil-works/pi-durable`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-codemode`, `@earendil-works/chord`, `@earendil-works/pi-ai`), with SDK 0.6.79, Zod 4.6.6, and Undici 8.12.2.
- **Runtime Task Graph Backend Projection (G1)**: Structured read-only projection model (`src/runtime-graph/`, `src/runner/runtime-graph-*.ts`) exposing live task lifecycle states (pending, running, waiting, sleeping, completing), dependency edges, debounced snapshots, scope filtering for root and child conversations, and bounded terminal task receipts (128 entries).
- **Session Admission Coordination & Single Writer Guarantee**: Introduced `SessionAdmissionCoordinator` with session-level mutex coordination. Concurrent `thread/start` and `turn/start` requests coalesce into a single execution, preventing SQLite lock contention crashes (`Session is already open in another process`). Implemented participant-level cancellation so stopping a waiting child does not kill active root work.
- **BB Identity Contract Hardening**: Enforced legitimate child alias resolution (`providerThreadId`), prevented foreign composite root attachment (`validateChildAttachment`), and blocked hostile same-thread identity replacement.
- **Comprehensive Boundary Remediation (R0–R5)**: Added typed contract compiler tests (`tsconfig.contract-tests.json`), negative contract compiler guard (`scripts/check-negative-contracts.mjs`), eliminated Tarjan import SCC cycles across 123 source files, and split touched modules to strictly satisfy AP-019 (<200 LOC per file).

### Note on Scope
- **Live Desktop Transport (G2) & Context Segment Renderer (G3)**: Public desktop Electron event transport and UI context segment renderer remain unproven/pending in the ongoing architecture loop and are not included or promised in this release.

---

## [0.2.53] - 2026-10-25

### Added
- **Subagent Model Policy v1**: Centralized subagent model and thinking level management (`inherit` or `configured`) via BB settings and namespaced KV store (`subagent.policy.v1`).

### Fixed
- **Native Edit Unified File-Change**: Resolved duplicate file-change rows for multi-region edits: produces one file entry per edit call with canonical unified git patch.
- **Runner Bundle Externalization**: Externalized Zod from the runner bundle, keeping runner size under 20KB.

---

## [0.2.52] - 2026-10-25

### Fixed
- **Tool Result Parity (tool-result-parity)**:
  - Fixed false failures for nested tool executions (`read`, `write`, `edit`, `bash`, MCP tools) inside `codemode` or script engines: correctly decodes native `event.result` for nested calls and `event.entry.model[0]` for model-issued calls.
  - Fixed details metadata extraction: reads canonical details from `entry.model[0].details` or `result.details` instead of diagnostic envelope `entry.data` (`{ diagnostics }`).
  - Fixed bash progress snapshots: maintains cumulative retained stdout snapshots across `append`, `trimStart`, and `set: ""` updates; metadata-only progress updates no longer wipe retained snapshots.
  - Fixed image presentation: restricted image formatting to genuine `type: "image"` blocks; generic JSON payloads containing `data` properties (e.g. `{ data: "customer-record" }`) are no longer corrupted into image descriptors; nested image base64 data is redacted while preserving sibling fields.
  - Eliminated module-global singleton state: scoped `ToolEventProjector` per adapter instance with clean resets on run boundaries and prefixed snapshot seeding for child conversations.

---

## [0.2.0] - 2026-10-07

### Added
- **Embedded TypeScript Runner (`dist/runner`)**: Migrated provider runner to a self-contained, high-performance TypeScript process communicating with BB over IPC file descriptors and standard JSON-RPC wire protocol.
- **Native Event Streaming (`watchEvents`)**: Subscribed directly to `@earendil-works/pi-durable` native transactional event stream (`watchEvents`), streaming turn lifecycle, thinking deltas, tool executions, and progress events with sub-millisecond latency.
- **Model Discovery with `enabledModels` Scoping**: Implemented automatic resolution of Pi's `enabledModels` pattern whitelist (`resolveModelScopeWithDiagnostics`). Only explicitly enabled models are advertised to BB IDE, keeping model pickers clean and relevant.
- **Dynamic Context Estimation & `/compact`**: Integrated real-time token estimation (`estimateContextTokens`) from conversation history, emitting context window deltas directly to BB timeline. Added support for manual `/compact` commands.
- **Model-Aware Compaction Configuration**: Refactored harness setup to resolve model-specific compaction thresholds from Pi's `settings.json` (`modelOverrides`) via `settingsManager.getCompactionSettings(model)`.
- **Steer & Turn Lifecycle Discipline**: Aligned runner input submission with BB's `turn/steer` contract, emitting `input.accepted` with `providerTurnId` and properly reconciling pending steers.
- **Discovery Handler & Protocol Modularization**: Extracted dedicated `discovery-handler.ts`, `jsonrpc.ts`, and `bb-event-adapter.ts` to strictly adhere to architectural boundaries (AP-010, AP-019).
- **Master Parity Roadmap (Cycles 56–67)**: Published comprehensive 12-cycle architectural plan (`docs/superpowers/plans/2026-10-07-arch-improvement-master-plan-pi-durable-parity.md`) for full engine parity and remediation.

### Fixed
- **Instant Per-Tool Output Completion**: Ensured individual tool completions emit immediately with aggregated output rather than stalling until turn completion.
- **Probe Mode Model Extraction**: Fixed model discovery in `--no-session` probe mode to reliably parse model catalogs from `raw.data.models`.
- **SQLite Directory Path Normalization**: Fixed handling of SQLite session directories and recursive cleanup on teardown.
- **Boundary & Error Types Discipline**: Replaced heuristic fallbacks with fail-fast typed contracts per AP-012 and AP-013.

---

## [0.1.0] - 2026-10-05

### Added
- Initial release of the Pi Durable provider plugin for BB IDE.
- Basic provider registration and bridge routing for durable conversations.
- SQLite-backed transactional session persistence.
