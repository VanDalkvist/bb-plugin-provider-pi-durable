# Independent S9 Architectural Review Report — R0–R6 / Pi 1.4

**Date:** 2026-10-25 / 2026-10-26  
**Repository:** `/Users/vanya/Projects/bb-plugin-provider-pi-durable`  
**Review Type:** S9 Independent Architectural Review (Read-Only)  
**Governing Documents:**  
- Repo `AGENTS.md`  
- `/Users/vanya/Projects/arch-improvement-skills/skills/arch-improvement-review/SKILL.md`  
- `/Users/vanya/Projects/arch-rules-skills/skills/arch-rules-implementation-review/SKILL.md`  
- `/Users/vanya/Projects/arch-rules/arch-rules.md` (AP-010 – AP-071)  
- `docs/superpowers/plans/2026-10-25-durable-1.4-boundary-remediation.md`  
- `docs/arch-improvement/reviews/2026-10-25-boundary-fixture-evidence.md`

---

## 1. Executive Summary & Verification Context

This review is the independent, read-only S9 architectural review of the completed R0–R6 implementation adapting the BB Provider to `@earendil-works/pi-durable` 1.4.0 and integrating all 11 findings from Cycles 104/105.

### Deployment & Version Grounding (Vanya's latest correction verified)
- **Repo Checkout (`/Users/vanya/Projects/bb-plugin-provider-pi-durable`):**  
  Base commit `7d0b5b8` (v0.2.53 / Pi 1.3), commits `3325275` and `8103a38`, plus current working tree (R5/R6 updates).
- **Installed BB Plugin State (`bb plugin list`):**  
  `provider-pi-durable@0.2.53  running` (source: `git:...@semver:^0.2.0`, cache commit `7d0b5b83258958eaa2e6c8b725ef0e779c0ecce1`).  
  *Confirmation:* The stale brief mention of `v0.2.52 / 4d02d4c7aefd` is completely superseded by reality; the installed host artifact is verified at `0.2.53`.
- **Pi Ecosystem Pins (`package.json` & `package-lock.json`):**  
  All Pi ecosystem packages resolve strictly to `1.4.0` (`@earendil-works/pi-durable`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-codemode`, `@earendil-works/pi-ai`, `@earendil-works/chord`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-mcp`, `@earendil-works/pi-telemetry`, `@earendil-works/pi-tui`).
- **Dependencies Security & Audit:**  
  `zod` is pinned to `^4.6.6` (resolves to `4.6.7`), `npm audit` reports **0 vulnerabilities**.
- **Execution Mode:**  
  Conducted strictly read-only by native subagent without modifying code, without opening user sessions, without spawning nested BB subthreads, and without restarting services.

---

## 2. Verification Execution & Empirical Evidence

Every check was executed directly in the project workspace with zero simulated assertions:

| Verification Gate | Command | Outcome / Measured Receipt |
|---|---|---|
| **Full Test Suite** | `npm test` | **441 Node + 9 UI = 450 pass**, 0 fail, 0 skipped (`18.2s` Node + `1.1s` UI) |
| **Source Typecheck** | `./node_modules/.bin/tsc --noEmit` | **Exit 0** (clean compilation of all 108 source TS files) |
| **Contract Tests Typecheck** | `./node_modules/.bin/tsc --noEmit -p tsconfig.contract-tests.json` | **Exit 0** (compiles factories, negative fixtures, 64 direct suites + split scenarios) |
| **Negative Compiler Guard** | `node scripts/check-negative-contracts.mjs` | **Verified**: virtual unsuppression triggers actual compiler error **TS2322**; source unchanged |
| **Import Graph & Cycles** | `node scripts/verify-import-graph.mjs` | **108 source files / 0 SCC** (0 circular import cycles) |
| **Line Budget (AP-019)** | Custom AST/line counter script | **108 src TS files**: 0 > 200 lines.<br>**154 touched/new TS files**: 0 > 200 lines (max: 196 lines in `bb-event-adapter.ts`). |
| **Plugin Build** | `npm run build` | **Exit 0**: builds `dist/runner/index.js`, `dist/server.js`, `dist/app.js`, `dist/host.js` cleanly |
| **Security Audit** | `npm audit` | **0 vulnerabilities** |
| **Doctor Smoke Test** | `node scripts/doctor.mjs` | **Exit 0**: Reports v0.2.53, Durable v1.4.0, discovers 7 extensions, 7 system tools, 6 extension tools, 238 skills |
| **SDK Typecheck Placement** | `bb plugin types --check` | **Exit 1**: Advisory diagnostic asking to move `@get-bb/plugin-sdk` to `devDependencies`. Retained in `dependencies` by design for standalone runner packaging (tested by `package-integrity.test.ts`). |

---

## 3. Systematic Finding-by-Finding Closure (11 Handed-Off Items)

### [P2-1 / F-104-1] Shared schema-inferred IPC contracts, stdout/FD3 classification, response ID+command correlation, fail-closed handling, privacy guard
- **Evidence:**  
  - Contracts defined in `src/contracts/{runner-event,runner-response,runner-channel,wire-message,wire-tool,wire-lifecycle}.ts`.
  - `src/host/runner-rpc-channel.ts` maintains `Map<string, PendingRequest>` with exact command tracking.
  - `src/host/runner-protocol-error.ts` defines `RunnerProtocolError` with strict codes (`MALFORMED_JSON`, `INVALID_MESSAGE`, `MISMATCHED_RESPONSE`, `FRAME_TOO_LARGE`, `CONSUMER_FAILURE`).
  - `decodeStdout` distinguishes `response` (validated against `runnerResponseSchema`), known events (validated against `runnerEventSchema`), and unknown event types (returns `undefined`, logged via bounded rate-limited trace `unknown_message` without dumping raw payload or types).
  - Malformed known frames immediately fail pending RPC requests with `RunnerProtocolError` and emit a structured `provider.warning` delta (`runnerProtocolWarning`). They **never fabricate** a native task failure or parent/child terminal boundary.
  - `handleIncoming` verifies `msg.command === pending.command`; command mismatch throws `MISMATCHED_RESPONSE`.
  - Logging never includes raw prompts, error messages, or JSON payloads (`tests/runner-privacy.test.ts` passes).
- **Rule:** AP-012, AP-016, AP-022, AP-024, AP-026, AP-043, AP-045.
- **Fix Decision:** `fix-now` — **VERIFIED RESOLVED**.

### [P2-2 / F-104-2] Command import Strongly Connected Components (SCC)
- **Evidence:**  
  - Three-node cycle between `session-commands.ts`, `binding-commands.ts`, and `session-state-commands.ts` was broken by extracting `src/runner/conversation-id.ts` (`parseConversationId`).
  - AST verification via `scripts/verify-import-graph.mjs` across all 108 source files confirms: `{"files": 108, "cycles": []}`.
  - Deterministic cycle oracle verified by `tests/import-graph.test.ts`.
- **Rule:** AP-011, AP-025.
- **Fix Decision:** `fix-now` — **VERIFIED RESOLVED**.

### [P2-3 / F-104-3] File line budgets (AP-019) across source and touched tests
- **Evidence:**  
  - Every one of the 108 source files in `src/` is strictly < 200 lines (soft budget 150, hard budget 200).
  - Splitting completed: `src/host/message-delta-translator.ts` is 175 lines, `src/host/reasoning-delta-translator.ts` is 40 lines, `src/host/tool-delta-translator.ts` is 179 lines, `src/host/delta-translator.ts` is 170 lines.
  - All 154 touched or new TS/TSX files across `src/` and `tests/` are <= 196 lines. Large legacy test suites outside the touched boundary were preserved without risk, while touched tests were split into scenario suites (e.g. `*.scenarios-2.test.ts`).
- **Rule:** AP-019.
- **Fix Decision:** `fix-now` — **VERIFIED RESOLVED**.

### [P2-4 / F-104-4] Runtime controller silent exception catches and safe diagnostics
- **Evidence:**  
  - `src/runner/compaction-hooks.ts` implements `runCompactionSideEffect` and `CompactionSideEffectError` with explicit typed codes (`CONTEXT_RETRIEVAL_FAILED`, `COMPACTION_HOOK_FAILED`).
  - Context retrieval failures in `runtime-controller.ts:97` produce distinct warnings without assuming empty context.
  - Extension hook rejections are best-effort with safe causal categories; secrets are never logged (`tests/compaction-hooks.test.ts` passes).
  - Native compaction in `runtime-controller.ts:107` executes authoritatively (`ctx.bindings.current.compact`), never wrapped in best-effort swallowers.
  - Zero empty catches (`assert.doesNotMatch(source, /\.catch\(\(\) => (?:\{\}|undefined)\)/)` verified).
- **Rule:** AP-012, AP-022, AP-023, AP-024.
- **Fix Decision:** `fix-now` — **VERIFIED RESOLVED**.

### [P3-1] Explicit PromptRequest DTO for session and router
- **Evidence:**  
  - `src/host/prompt-request.ts` defines `PromptRequest { text: string; images?: PiPromptImage[]; conversationId?: string; }`.
  - `PiThreadSession.prompt(request: PromptRequest)` and `steer(request: PromptRequest)` in `src/host/session.ts` accept only the typed DTO. Positional production overloads were eliminated.
  - Verified by `tests/prompt-request.test.ts`.
- **Rule:** AP-021, AP-026.
- **Fix Decision:** `fix-now` — **VERIFIED RESOLVED**.

### [P3-2] Pure mirror adoption decision and terminal buffer flush boolean
- **Evidence:**  
  - `src/host/mirror-adoption.ts` extracts `decideMirrorAdoption` as a pure function over `MirrorSnapshot` and input text.
  - `adoptInitialMirror` coordinates through `MirrorAdoptionPort` (`markConsumed`, `register`, `output`, `consumeCompleted`) and returns `{ kind, terminalEmitted, outputText }`.
  - `src/host/bridge-router.ts` checks `adoption.terminalEmitted`; if terminal boundary was already flushed during registration, it suppresses duplicate synthesized completion deltas.
  - Router no longer mutates or intercepts `ctx.sendNotification` to detect terminal boundaries.
  - Verified by `tests/mirror-adoption.test.ts`.
- **Rule:** AP-011, AP-018, AP-020, AP-032.
- **Fix Decision:** `fix-now` — **VERIFIED RESOLVED**.

### [P3-3] Typed boundary fixtures and contract compiler enforcement
- **Evidence:**  
  - Canonical fixtures implemented in `tests/fixtures/{wire,commands,mirror,durable}.ts` and typed contracts in `tests/types/{wire,commands,mirror,durable}.ts`.
  - `tsconfig.contract-tests.json` includes all factories and 64 direct consumer test suites.
  - `scripts/check-negative-contracts.mjs` is integrated into `npm test` (`npm run test:contracts`), ensuring that any type regression in the negative contract fixture causes build failure with TS2322.
- **Rule:** AP-026, AP-028, AP-029, AP-056, AP-057.
- **Fix Decision:** `fix-now` — **VERIFIED RESOLVED**.

### [P3-4] Host diagnostics ownership, contracts, and shared child-title
- **Evidence:**  
  - Diagnostics implementation moved to `src/host/diagnostics.ts`, contracts to `src/contracts/diagnostics.ts`, shared title logic to `src/shared/child-title.ts`.
  - Static search confirms 0 imports from `src/runner/` into `src/host/`.
  - Title sanitization verified for unicode, control characters, and length ceilings in `tests/subagent-title-sanitization.test.ts`.
- **Rule:** AP-010, AP-020, AP-025.
- **Fix Decision:** `fix-now` — **VERIFIED RESOLVED**.

### [P3-5] Direct runtime-types imports without composition-root re-exports
- **Evidence:**  
  - `DurableView` is exported solely by `src/runner/runtime-types.ts`.
  - `src/runner/runtime.ts` does not re-export `DurableView`.
  - All 6 bridge/watcher consumers (`subagent-watcher.ts`, `bridge/bb-event-adapter.ts`, `bridge/bb-child-event-adapter.ts`, `bridge/turn-summary.ts`, `bridge/assistant-message-builder.ts`, `bridge/tool-args-resolver.ts`) import `DurableView` directly from `runtime-types.ts`.
  - Enforced by regex check in `tests/contract-locality.test.ts`.
- **Rule:** AP-010, AP-025.
- **Fix Decision:** `fix-now` — **VERIFIED RESOLVED**.

### [P3-6] RuntimeBindings ownership and epoch-guarded subscriptions
- **Evidence:**  
  - `src/runner/runtime-bindings.ts` encapsulates current `Conversation`, `ConversationView`, `TaskGraph` attachments, and subscription lifecycles.
  - Subscriptions are epoch-guarded (`this.epoch`, `this.taskEpoch`), ensuring stale callbacks from previous conversations or task attachments cannot mutate active view state.
  - View disposal is guaranteed upon replacement or failure.
  - Controller receives operations through `RuntimeBindingPort`, removing the public mutable state bag from `runtime-controller.ts`.
  - Verified by `tests/runtime-bindings.test.ts`.
- **Rule:** AP-011, AP-018, AP-023, AP-034.
- **Fix Decision:** `fix-now` — **VERIFIED RESOLVED**.

### [P3-7] Structured diagnostics report schema and Doctor preservation
- **Evidence:**  
  - `src/contracts/diagnostics.ts` defines `piDiagnosticsReportSchema` using standard Zod object and array definitions without `z.custom`.
  - `rpcContract.diagnostics_get` validates output using Standard Schema via `piDiagnosticsReportSchema`.
  - `scripts/doctor.mjs` executes cleanly against the live environment.
  - Settings UI slot (`subagent-model-policy`) preserved; obsolete prototype Doctor UI is not revived.
  - Verified by `tests/diagnostics-contract.test.ts`.
- **Rule:** AP-026, AP-029, AP-059.
- **Fix Decision:** `fix-now` — **VERIFIED RESOLVED**.

---

## 4. Pi 1.4 Native Capabilities & Parity Verification

1. **Courier Liveness & Dedup:**  
   `src/runner/subagent-delivery.ts:14` implements `courierIsIdle(active)` returning `active === undefined || active.state.status === "terminal"`. Tasks in status `"running"`, `"sleeping"`, or `"completing"` are considered active. When new reports arrive while a courier is sleeping, they are appended to the outbox without creating duplicate courier tasks (`tests/durable-1.4-courier.test.ts` passes).
2. **Native SleepUntil & Deadlines:**  
   Courier phases use `runtime.sleepUntil(runtime.now() + GATHER_MS, { phase: "next" }, context)`. Durably persists deadline across process reopens without busy-waiting.
3. **No Persisted Doc Kind/Version Breaking Changes:**  
   `checkpointWhen: () => false` added to `SubagentsDoc`, `SubagentPolicyAckDoc`, and `BindingDoc` to suppress unnecessary document snapshots while keeping versions at `version: 1`. Existing SQLite transcript and binding recovery verified against real 1.3 fixtures (`tests/durable-1.4-migration.test.ts` passes).
4. **Task Completion State Mapping:**  
   `src/runner/task-graph-bridge.ts:12` maps native `"completing"` status onto `"completed"` or `"failed"` based on `state.outcome`, preventing UI spinners from hanging while child tasks drain.

---

## 5. Explicit Residual Risks & Out-of-Scope Exceptions (Triage: log-only)

The 6 explicit residual items outside the four selected boundary seams (identified in `docs/arch-improvement/reviews/2026-10-25-boundary-fixture-evidence.md`) were evaluated:

- [P3] Legacy compaction hook payload assertions
  - Evidence: `src/runner/runtime-controller.ts:100` uses `as any` casts for legacy `firstKeptEntryId`, `messagesToSummarize`, and `branchEntries` passed to coding-agent extension hooks.
  - Impact: Native Durable compaction remains authoritative and hook errors are caught safely via `runCompactionSideEffect`; legacy hook payload shape fidelity is outside the four-seam scope.
  - Rule: AP-029
  - Fix decision: `log-only` (acceptable residual; native Durable handles compaction).

- [P3] Headless UI context shim for extensions
  - Evidence: `src/runner/extension-bridge.ts:31` provides no-op methods for terminal UI.
  - Impact: Extensions attempting interactive full-terminal UI cannot render in headless background daemon.
  - Rule: AP-054
  - Fix decision: `log-only` (appropriate for headless daemon runtime).

- [P3] Test fakes in subagent courier delivery suites
  - Evidence: `tests/subagent-courier-delivery*.test.ts` use simulated `TaskRuntime` algorithms for unit assertions.
  - Impact: Separately proven against real native Harness in `tests/durable-1.4-courier.test.ts`.
  - Rule: AP-028
  - Fix decision: `log-only` (covered by integration suite).

- [P3] Native AgentEvent producer-input stubs across tests
  - Evidence: Various test suites construct partial `AgentEvent` objects as inputs to adapters.
  - Impact: Outbound wire contracts are strictly validated; upstream inputs do not violate adapter outbound boundaries.
  - Rule: AP-028
  - Fix decision: `log-only`.

- [P3] Private-field lifecycle inspection in `tests/cwd-isolation.test.ts`
  - Evidence: Test inspects runner options via typed constructor options.
  - Impact: Minor private rename risk would trigger immediate test failure during CI.
  - Rule: AP-028
  - Fix decision: `log-only`.

- [P3] Private event-delivery hooks in session interruption/mirror tests
  - Evidence: `tests/interruption-delta.test.ts` feeds events through internal session hooks.
  - Impact: Test-only coupling; runtime behavior is verified.
  - Rule: AP-028
  - Fix decision: `log-only`.

- [P3] `@get-bb/plugin-sdk` in `dependencies` triggering `bb plugin types --check` advisory
  - Evidence: `bb plugin types --check` exits with code 1 advising to move SDK to `devDependencies`.
  - Impact: The standalone provider runner is packaged and executed in subprocesses where BB host SDK injection is unavailable; `package-integrity.test.ts` strictly asserts SDK presence in `dependencies`.
  - Rule: AP-010, AP-026
  - Fix decision: `log-only` (architectural requirement of standalone runner packaging).

---

## 6. Architecture Verification Summary

```markdown
Architecture verification
- Passed: AP-010 (Modular Monolith + Ports & Adapters)
- Passed: AP-011 (Low coupling, high cohesion: 0 SCC)
- Passed: AP-012 (Fail-fast and explicit error contracts: RunnerProtocolError, fail-closed)
- Passed: AP-013 (Data integrity: ACID SQLite checkpoints, cold recovery)
- Passed: AP-016 (Trusted security boundary: no raw prompt/secret logging)
- Passed: AP-018 (Single responsibility: decoupled translators and adoption)
- Passed: AP-019 (Line budget: 108/108 src TS < 200 lines; 154/154 touched TS < 200 lines)
- Passed: AP-020 (Clean Architecture & composition root: zero runner->host imports)
- Passed: AP-021 (Thin entry points: bridge router delegates to pure ports)
- Passed: AP-022 (Typed errors: CompactionSideEffectError, RunnerProtocolError)
- Passed: AP-023 (Async discipline: no floating promises, queue serialization)
- Passed: AP-024 (Observability and secret protection: safe JSON log formatting)
- Passed: AP-025 (Import discipline: 0 cycles, direct runtime-types imports)
- Passed: AP-026 (API contracts & DTO boundaries: Zod-inferred wire/response/event DTOs)
- Passed: AP-028 (Testing strategy & determinism: 450 passing tests, deterministic fixtures)
- Passed: AP-029 (TypeScript strictness: dual compiler checks + negative TS2322 guard)
- Passed: AP-032 (Command/Query separation: DurableViewSource vs execution commands)
- Passed: AP-034 (Concurrency strategy: session lock eviction, epoch-guarded subscriptions)
- Passed: AP-038 (Request context and traceability: command/response ID correlation)
- Passed: AP-043 (Safe input handling: boundary Zod parsing, 16MB frame limit)
- Passed: AP-048 (Identifier correspondence: parseConversationId)
- Passed: AP-050 (Status and enum contracts: explicit discriminated unions)
- Passed: AP-056 (Risk-oriented testing: negative compiler contract guard)
- Passed: AP-057 (Deterministic test data: contract test factories)
- Passed: AP-059 (Health checks & readiness: Pi Doctor CLI and startup handshake)
- Not applicable: AP-062 (Postgres OLTP guardrails — SQLite/Durable architecture)
- Not applicable: AP-065 (Next.js default for admin — Beyond Boundaries IDE extension)
- Residual risk: 7 triaged P3 items (legacy compaction hook payloads, headless UI stubs, SDK package placement advisory). All residual risks are bounded, tested, and non-blocking.
```

---

## 7. Final Review Verdict

**VERDICT: PASS**

- Zero open or unresolved P0, P1, or P2 defects.
- All 11 Cycle 104/105 findings are fully resolved and empirically verified against actual source code and test runs.
- 450 tests passing (441 Node + 9 UI), dual TypeScript compilers green, negative TS2322 contract guard executing, 0 import cycles across 108 source files, and 100% compliance with AP-019 line budgets (<200 lines).
- Pi 1.4 ecosystem pins cleanly aligned at `1.4.0` with 0 npm audit vulnerabilities.
