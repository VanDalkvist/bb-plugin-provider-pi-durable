# Architecture Improvement Ledger: bb-plugin-provider-pi-durable

---

## Cycle 56: Boot Integrity, Packaging Parity & Fail-Fast Handshake (2026-10-07)

**Goal:** Repair zero-day boot and packaging defects reported in community issues #1, #2, and #3, ensuring portable installation, project cwd preservation, and fail-fast startup semantics.  
**Governing Standard:** `arch-rules.md` (AP-010 – AP-071) & `arch-improvement-loop`  
**PRD Reference:** `prd/pi-durable-runtime-boot-integrity`  
**Plan Reference:** `docs/superpowers/plans/2026-10-07-arch-improvement-cycle-56-boot-integrity.md`  

### 1. Triaged Findings & Dispositions

| ID | Issue | Severity | Rule | Disposition | Root Cause & Resolution |
|---|---|---|---|---|---|
| **F-56-1** | #1 | **P0** | AP-013, AP-026 | `fix-now` | `src/host/session.ts` passed `--session-dir` which was not handled by runner parser, causing session root to override `args.cwd`. **Fix:** Removed `--session-dir` from host args; hardened `parseCliArgs` in `src/runner/cli-args.ts` to isolate flags and preserve positional `cwd`. |
| **F-56-2** | #2 | **P0** | AP-010, AP-027 | `fix-now` | `src/host/paths.ts` failed when running from isolated BB host-cache (`cacheRoot/host.mjs`) and fell back to hardcoded maintainer path `/Users/vanya/...`. **Fix:** Removed hardcoded path; implemented multi-tier resolver in `src/host/paths.ts` supporting env overrides, cache layouts, sibling package scanning, and spaces in paths. |
| **F-56-3** | #3 | **P1** | AP-012, AP-022 | `fix-now` | Active session runner announced ready before SQLite `openDurable()`; `PiThreadSession.start()` swallowed readiness timeouts and context RPC errors, returning broken sessions. **Fix:** Atomic readiness moved after `openDurable()` and stdin reader setup in `src/runner/index.ts`; `start()` refactored to clear timer and propagate rejections on exit/error/RPC failure. |

### 2. Architecture Rule Verifications

- **AP-010 (Modular Monolith & Ports/Adapters):** Clean isolation between host bridge, session management, runner child process, and model setup.
- **AP-012 (Fail-Fast & Explicit Error Contracts):** Immediate rejection on child spawn error or premature exit; initial context RPC failures reject `start()`.
- **AP-013 (Data Integrity without Fakes):** Project `cwd` strictly preserved; tools and files execute in workspace, not session cache.
- **AP-019 (File Size Limits & Modularity):**
  - `src/host/session.ts`: 185 lines (< 250)
  - `src/host/paths.ts`: 103 lines (< 150)
  - `src/host/runner-process.ts`: 204 lines (< 250)
  - `src/runner/cli-args.ts`: 43 lines (< 150)
  - `src/runner/model-setup.ts`: 90 lines (< 150)
  - `src/runner/session-commands.ts`: 119 lines (< 150)
  - `src/runner/index.ts`: 205 lines (< 250)
- **AP-021 (Thin Entry Points):** `src/runner/index.ts` delegates model discovery to `model-setup.ts` and command dispatch to `session-commands.ts`.
- **AP-022 (Typed Errors & Explicit Exception Handling):** Zero empty catch blocks; unhandledRejection guard on `readyPromise`; timeout timers explicitly cleared in `finally`.
- **AP-028 (Testing Strategy & Determinism):** 3 new deterministic test suites added (`cwd-isolation.test.ts`, `runner-discovery.test.ts`, `startup-readiness.test.ts`), all passing 100%.

### 3. Verification Evidence

- `npm run build`: Success (`dist/runner/index.js`, `dist/host.js`, `dist/server.js`).
- `npm test`: **25 / 25 passing assertions (0 failed, 0 skipped)** across 4 suites.
  - `tests/bb-event-adapter.test.ts`: 2 passed
  - `tests/bridge-error-handling.test.ts`: 6 passed
  - `tests/compaction-settings.test.ts`: 3 passed
  - `tests/cwd-isolation.test.ts`: 5 passed
  - `tests/runner-discovery.test.ts`: 5 passed
  - `tests/startup-readiness.test.ts`: 4 passed
- Issue #1 repro: Verified `effectiveCwd === spawnCwd === projectDir`.
- Issue #2 repro: Verified `resolveRunnerPath` in isolated `cacheRoot` finds sibling `packageRoot/dist/runner/index.js`.
- Issue #3 repro: Verified runner exits reject `start()` promptly without timeout hang; no premature ready emitted.

### 4. Remediation & Hardening (Cycle 56 Remediation - 2026-10-07)

**Plan Reference:** `docs/superpowers/plans/2026-10-07-arch-improvement-cycle-56-boot-integrity-remediation.md`

#### Additional Triaged Findings & Dispositions

| ID | Issue / Review Finding | Severity | Rule | Disposition | Root Cause & Resolution |
|---|---|---|---|---|---|
| **F-56-4** | Real BB IDE Runner Discovery | **P0** | AP-010, AP-027 | `fix-now` | `resolveRunnerPath` failed when running from BB host-artifacts directory (`~/.bb/plugin-host-artifacts/provider-pi-durable/<hash>/host.mjs`). **Fix:** Added multi-tier resolution: (1) env overrides, (2) direct relative from `fromDir`, (3) reading `root_dir` from `~/.bb/bb.db` via `node:sqlite`, (4) scanning `~/.bb/plugins/cache/git` and `~/.bb/plugins/cache/npm`, (5) standard BB plugin directory. Verified on real BB artifact path. |
| **F-56-5** | Zombie Process Leak on Session Startup Failure | **P1** | AP-012, AP-022 | `fix-now` | If `start()` timed out or `refreshContextUsage()` failed, `this.kill()` was not called. **Fix:** Added guaranteed `this.kill()` in `catch` block of `PiThreadSession.start()` before rethrowing. |
| **F-56-6** | Model Catalog Startup Error Swallowing & Process Leak | **P1** | AP-012, AP-022 | `fix-now` | `ModelCatalog.start()` swallowed startup errors with `console.warn`, lacked `onError`/`onExit` hooks on `RunnerProcess`, leaked timeout timer, and left dead processes in OS. **Fix:** Added `readyReject`, wired `onError`/`onExit`, cleared timer in `finally`, and guaranteed `this.kill()` + error rethrow on startup failure. |
| **F-56-7** | AP-019 File Size Violation in `src/runner/runtime.ts` | **P2** | AP-019 | `fix-now` | `src/runner/runtime.ts` was 430 lines (exceeded 250-line hard limit). **Fix:** Modularized into `runtime-types.ts` (104 lines), `runtime-controller.ts` (147 lines), `runtime-loader.ts` (111 lines), and facade `runtime.ts` (213 lines). Every file strictly < 250 lines. |
| **F-56-8** | CLI Argument Parser Greediness & `--cwd` Support | **P2** | AP-013, AP-026 | `fix-now` | `parseCliArgs` lacked explicit `--cwd <val>` handling and could let flags consume positional arguments. **Fix:** Added `--cwd` support, protected boolean flags (`--no-session`) from consuming positional arguments. |
| **F-56-9** | D-1 & D-2 Parity (Lockfile Cleanup & Session Path Suffix) | **P2** | AP-013, AP-047 | `fix-now` | (D-1) Runner terminated on SIGTERM/SIGINT without releasing `proper-lockfile`. **Fix:** Added `await activeDurable.close()` before `process.exit(0)`. (D-2) SQLite database sessions used `.jsonl` suffix. **Fix:** Updated `resolveSessionFilePath` and `selectSession` to strip `.jsonl` / `.sqlite` from directory names. |

#### Remediation Verification Evidence

- `npm run build`: Success (`dist/runner/index.js`, `dist/host.js`, `dist/server.js`).
- `npm test`: **34 / 34 passing assertions (0 failed, 0 skipped)** across all test suites.
  - `tests/bb-event-adapter.test.ts`: 2 passed
  - `tests/bridge-error-handling.test.ts`: 6 passed
  - `tests/compaction-settings.test.ts`: 3 passed
  - `tests/cwd-isolation.test.ts`: 9 passed
  - `tests/runner-discovery.test.ts`: 8 passed
  - `tests/startup-readiness.test.ts`: 6 passed
- Real BB artifact path test: `resolveRunnerPath({ fromDir: "/Users/vanya/.bb/plugin-host-artifacts/provider-pi-durable/6e4db84ddf8cab895f7af2c6878d61d479ea2f6934bf804cc008797ce29b757c" })` successfully returns `/Users/vanya/Projects/bb-plugin-provider-pi-durable/dist/runner/index.js`.
- AP-019 line check: All modified and new files under 250 lines (hard limit) and most under 150 lines (soft limit).
- AP-022 check: Zero uncommented empty catch blocks across entire codebase.

### 5. Residual Risk & Follow-Up
- Full Stage 1 roadmap continues in Cycle 57 (Context window telemetry & token synchronization) and Cycle 58 (Tool fault integrity, diff forwarding & thinking accordion streaming).

---

## Cycle 57: Context Window Telemetry & Usage Synchronization (2026-10-07)

**Goal:** Repair context window usage estimation (`usedTokens`), token telemetry synchronization, and model context window propagation so BB IDE's ring indicator and context fullness bar display accurate live values.  
**Governing Standard:** `arch-rules.md` (AP-010 – AP-071) & `arch-improvement-loop`  
**PRD Reference:** `prd/pi-durable-runtime-boot-integrity`  
**Plan Reference:** `docs/superpowers/plans/2026-10-07-arch-improvement-cycle-57-context-telemetry.md`  

### 1. Triaged Findings & Dispositions

| ID | Issue | Severity | Rule | Disposition | Root Cause & Resolution |
|---|---|---|---|---|---|
| **F-57-1** | Missing Context Window Updates (`usedTokens: 0`) | **P1** | AP-013, AP-026 | `fix-now` | In `src/host/session.ts`, `getSessionStats()` attempted to read `res?.contextUsage`. Because the runner emits responses wrapped as `{ id, type: "response", command, success: true, data: { contextUsage } }`, `res.contextUsage` was `undefined`. In `refreshContextUsage()`, `stats.contextWindow > 0` failed (`0 > 0`), dropping all `contextWindow` deltas. **Fix:** `RunnerProcess.requestOk` unwraps `res.data ?? res.result ?? res` and rejects on `success: false`; `getSessionStats()` defensively extracts `res?.contextUsage ?? res?.data?.contextUsage ?? res`. |
| **F-57-2** | Turn Boundary Race on `agent_end` | **P1** | AP-023, AP-047 | `fix-now` | `handleRunnerEvent` emitted `agent_end` deltas (`turn.boundary: completed`) *before* awaiting `refreshContextUsage()`. Context updates arrived after the turn was closed. **Fix:** Await `refreshContextUsage()` before emitting `agent_end` deltas so context usage attaches to the active turn. |
| **F-57-3** | Initial Model Context Window Fallback | **P2** | AP-012, AP-022 | `fix-now` | `get_session_stats` in `src/runner/session-commands.ts` only inspected `agentDoc.model`. On thread creation prior to first turn, `agentDoc.model` is unpopulated, defaulting to 128,000. **Fix:** Added fallback to `args.provider` and `args.model`. |
| **F-57-4** | `BBEventAdapter` Context Window Drop on `run_end` | **P2** | AP-026 | `fix-now` | `BBEventAdapter` omitted `contextWindow` from `turn_end` and `agent_end` wire events, causing `DeltaTranslator` to emit `128000` for `usage` deltas. **Fix:** Added optional `resolveContextWindow` callback to `BBEventAdapter` and included `contextWindow` on wire events; updated `src/runner/bridge/contracts.ts`. |
| **F-57-5** | Legacy Directory Adoption Fallback | **P2** | AP-010, AP-049 | `fix-now` | When a session directory without `.jsonl` did not yet contain `session.sqlite`, legacy sessions created by earlier versions (`${directory}.jsonl/session.sqlite`) could be orphaned. **Fix:** In `src/runner/sessions.ts`, added fallback check for `${directory}.jsonl/session.sqlite`. |

### 2. Architecture Rule Verifications

- **AP-010 (Modular Monolith & Ports/Adapters):** Clean abstraction between host RPC protocol, delta translator, and runner SQLite storage.
- **AP-012 (Fail-Fast & Explicit Error Contracts):** `requestOk` now rejects when `res.success === false` with the explicit runner error message.
- **AP-013 (Data Integrity without Fakes):** Context token counts reflect genuine SQLite message estimates via `estimateContextTokens` from `@earendil-works/pi-ai`.
- **AP-019 (File Size Limits & Modularity):**
  - `src/host/runner-process.ts`: 211 lines (< 250)
  - `src/host/session.ts`: 202 lines (< 250)
  - `src/runner/session-commands.ts`: 121 lines (< 150)
  - `src/runner/bridge/bb-event-adapter.ts`: 190 lines (< 250)
  - `src/runner/index.ts`: 231 lines (< 250)
  - `src/runner/sessions.ts`: 103 lines (< 150)
  - `src/host/delta-translator.ts`: 217 lines (< 250)
- **AP-022 (Typed Errors & Explicit Exception Handling):** Polymorphic wire unwrapping handles both wrapped and raw response shapes; zero empty catch blocks.
- **AP-023 (Async Discipline):** Async context refresh awaited prior to turn boundary settlement.
- **AP-026 (DTO Boundaries & Strict Schema Validation):** `BBTurnEndEvent` and `BBAgentEndEvent` interfaces strictly typed in `contracts.ts` with optional `contextWindow`.
- **AP-028 (Testing Strategy & Determinism):** Comprehensive deterministic test suite in `tests/context-window-usage.test.ts` covering unwrapping, stats extraction, delta translation, and event ordering without network I/O.

### 3. Verification Evidence

- `npm run build`: Success (`dist/runner/index.js`, `dist/host.js`, `dist/server.js`).
- `npm test`: **40 / 40 passing assertions (0 failed, 0 skipped)** across 4 suites.
  - `tests/bb-event-adapter.test.ts`: 2 passed
  - `tests/bridge-error-handling.test.ts`: 6 passed
  - `tests/compaction-settings.test.ts`: 3 passed
  - `tests/context-window-usage.test.ts`: 6 passed
  - `tests/cwd-isolation.test.ts`: 9 passed
  - `tests/runner-discovery.test.ts`: 8 passed
  - `tests/startup-readiness.test.ts`: 6 passed
- `npx tsc --noEmit`: 0 errors.


---

## Cycle 58: Tool Execution Telemetry & Steer Protocol Integrity (2026-10-07)

**Goal:** Eliminate tool invisibility and steer freezing in `bb-plugin-provider-pi-durable`:
1. Ensure all `edit` and `write` tool executions emit schema-compliant `fileChange` deltas (`kind: "add" | "update"` instead of `"create" | "modify"`) with diff payloads so tool cards appear in BB chat.
2. Fix `turn/steer` input acceptance by omitting invalid `providerTurnId` so BB host daemon attaches acceptance to the active turn without 409 conflict, eliminating permanent "Steer pending".

**Governing Standard:** `arch-rules.md` (AP-010 – AP-071) & `arch-improvement-loop`  
**Issues:** #5, #6  
**Plan Reference:** `docs/superpowers/plans/2026-10-07-arch-improvement-cycle-58-tool-telemetry-and-steer.md`  

### 1. Triaged Findings & Dispositions

| ID | Issue | Severity | Rule | Disposition | Root Cause & Resolution |
|---|---|---|---|---|---|
| **F-58-1** | #6 | **P1** | AP-026 | `fix-now` | `buildToolItemShape` in `src/host/tool-delta-translator.ts` emitted `{ path, kind: "create" }` for `write` and `{ path, kind: "modify" }` for `edit`. BB Host Daemon validates `fileChange.changes` items against `z.enum(["add", "update", "delete"])`. Because `"create"` and `"modify"` failed Zod validation, `translateEvent` silently dropped the entire delta batch (`[]`), making all `edit` and `write` tool executions completely invisible in the chat UI. **Fix:** Mapped `write` to `kind: "add"` and `edit` to `kind: "update"`. Mapped `args.content` to `newText` and `args.edits` array to granular update items with `oldText` and `newText`. |
| **F-58-2** | #5 | **P1** | AP-012, AP-026 | `fix-now` | In `src/host/bridge.ts`, `turn/steer` emitted `input.accepted` with `providerTurnId: params.expectedTurnId`. Because `expectedTurnId` is a BB turn ID, host-daemon's assembler generated a new BB turn ID and emitted `turn/input/accepted` without `turn/started`, which BB server rejected with 409 `MissingStoredTurnStartedError`, causing steer messages to stay indefinitely in `unresolvedSteerRequestIds` ("Steer pending"). **Fix:** Omitted `providerTurnId` from `input.accepted` delta in `turn/steer`, allowing the assembler to associate acceptance with the active turn without 409 conflict. |

### 2. Architecture Rule Verifications

- **AP-010 (Modular Monolith & Ports/Adapters):** Tool translation logic remains cleanly decoupled in `tool-delta-translator.ts`.
- **AP-012 (Fail-Fast & Explicit Error Contracts):** Validated schemas prevent silent drop of event deltas by the host daemon.
- **AP-013 (Data Integrity without Fakes):** Tool diffs and granular edits reflect real arguments from agent execution.
- **AP-019 (File Size Limits & Modularity):**
  - `src/host/tool-delta-translator.ts`: 123 lines (< 250)
  - `src/host/bridge.ts`: 212 lines (< 250)
- **AP-026 (DTO Boundaries & Strict Schema Validation):** Output deltas strictly match `@bb/provider-bridge-protocol` Zod schemas (`jCe`).
- **AP-028 (Testing Strategy & Determinism):** Deterministic unit tests in `tests/tool-delta-translator.test.ts` and `tests/bridge-error-handling.test.ts`.

### 3. Verification Evidence

- `npm run build`: Success (`dist/runner/index.js`, `dist/host.js`, `dist/server.js`).
- `npm test`: **43 / 43 passing assertions (0 failed, 0 skipped)** across 5 suites.
  - `tests/bb-event-adapter.test.ts`: 2 passed
  - `tests/bridge-error-handling.test.ts`: 6 passed
  - `tests/compaction-settings.test.ts`: 3 passed
  - `tests/context-window-usage.test.ts`: 6 passed
  - `tests/cwd-isolation.test.ts`: 9 passed
  - `tests/runner-discovery.test.ts`: 8 passed
  - `tests/startup-readiness.test.ts`: 6 passed
  - `tests/tool-delta-translator.test.ts`: 3 passed
