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

### 4. Residual Risk & Follow-Up
- Full Stage 1 roadmap continues in Cycle 57 (Tool fault integrity & diff forwarding) and Cycle 58 (Thinking accordion streaming & turn checkpoints).
