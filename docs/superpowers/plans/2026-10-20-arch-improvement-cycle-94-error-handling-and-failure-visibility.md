# Cycle 94: Error Handling & Failure Visibility Parity (AP-013, AP-022, AP-026)

**Goal:** Eliminate silent turn termination and empty assistant messages on API errors (timeouts, 429 rate limits, location errors, model unavailability), ensuring accurate error propagation across Runner Wire contracts, user-visible fallback messages in the transcript, and canonical `turn.boundary` failure reporting (`status: "failed"` with `error: { message }`).

## Architecture Context Reference
- **Source Documents:** `AGENTS.md`, `docs/arch-improvement/ledger.md` (Cycle 91–93), `docs/arch-improvement/memory.md`.
- **Territories:**
  - Runner Wire: `src/runner/bridge/contracts.ts`, `src/runner/bridge/bb-event-adapter.ts`, `src/runner/bridge/assistant-message-builder.ts`, `src/runner/bridge/turn-summary.ts`.
  - Host Translation: `src/host/types.ts`, `src/host/message-delta-translator.ts`.
- **Architecture Constraints:**
  - AP-013: Deterministic Event Pipeline (no dropped lifecycle transitions).
  - AP-019: Strict line budgets (`src/runner/*.ts` < 200 lines; `src/host/*.ts` < 250 lines).
  - AP-022: No silent failures or swallowed error states.
  - AP-026: Strict Beyond Boundaries Provider Bridge protocol parity (`turn.boundary` schema conformance).

## Selected Findings (Fix-Now)
- **F-94-1 [P0]**: `BBEventAdapter` and `assistant-message-builder` evaluate `msg.content ?? [...]`, which produces `content: []` when an error occurs before streaming, dropping `errorMessage`.
- **F-94-2 [P0]**: `message-delta-translator` always emits `turn.boundary` with `status: "completed"` even when `stopReason === "error"`, never attaching `error: { message }`.
- **F-94-3 [P1]**: Wire contracts (`contracts.ts` and `types.ts`) lack typed `errorMessage` in `BBAssistantMessage`, `BBTurnEndEvent`, `BBAgentEndEvent`, and `RunnerEvent`.
- **F-94-4 [P2]**: Chat transcript has no visible error message bubble when turn fails before text deltas are emitted.

## Planned Slices (TDD Checkbox Steps)

- [ ] **Task 1: Wire Contracts & Type Definitions (F-94-3)**
  - Update `BBAssistantMessage` in `src/runner/bridge/contracts.ts` to include optional `errorMessage?: string`.
  - Update `BBTurnEndEvent` and `BBAgentEndEvent` to include optional `errorMessage?: string`.
  - Update `RunnerEvent` in `src/host/types.ts` to include optional `errorMessage?: string`.
  - Verify line count of `contracts.ts` stays < 200 lines.

- [ ] **Task 2: Failing Test for Runner Error Propagation (F-94-1, F-94-4)**
  - Create test in `tests/error-handling-visibility.test.ts` checking:
    1. `BBEventAdapter.handleEvent` on `message_end` with `stopReason: "error"`, `errorMessage: "Antigravity API error (429)"`, and empty `content: []`:
       - Emits `message_end` with non-empty content containing the error text (`⚠️ Antigravity API error (429)`).
       - Preserves `errorMessage` on the message.
    2. `resolveTurnSummary` / `emitTerminal` on `turn_end` / `run_end`:
       - Sets `stopReason: "error"`.
       - Sets `errorMessage` on the terminal event (`turn_end` / `agent_end`).
  - Run `node --test tests/error-handling-visibility.test.ts` to observe expected failure (Red).

- [ ] **Task 3: Implementation of Runner Error Adapter & Summary (F-94-1, F-94-4)**
  - Update `assistant-message-builder.ts`:
    - In `buildFinalAssistantMessage`: if `lastAssistantMsg.content` has length 0 and `lastAssistantMsg.stopReason === "error"`, populate content with `[{ type: "text", text: `⚠️ ${lastAssistantMsg.errorMessage ?? "An error occurred during turn generation."}` }]`.
    - Preserve `errorMessage` in returned `BBAssistantMessage`.
  - Update `turn-summary.ts`:
    - Detect `isError` when `finalMsg.stopReason === "error"` or tail assistant entry has `stopReason === "error"`.
    - Extract `errorMessage`.
    - Return `isError` and `errorMessage` in `TurnSummaryResult`.
  - Update `bb-event-adapter.ts`:
    - In `message_end`: if `msg.content` is empty and `(msg.stopReason === "error" || msg.errorMessage)`, generate fallback text content with `msg.errorMessage`.
    - In `emitTerminal`: attach `stopReason: "error"` and `errorMessage` when `summary.isError` is true.
  - Run `node --test tests/error-handling-visibility.test.ts` to verify Green.
  - Verify line budget of `bb-event-adapter.ts` stays < 200 lines.

- [ ] **Task 4: Failing Test for Host `turn.boundary` Failure Translation (F-94-2)**
  - Add test in `tests/error-handling-visibility.test.ts`:
    - `translateAgentEnd` with `stopReason: "error"` and `errorMessage: "Rate limit exceeded"`:
      - Emits `turn.boundary` with `status: "failed"`.
      - Emits `turn.boundary` with `error: { message: "Rate limit exceeded" }`.
      - Emits `item.textClose` on channel `agentMessage` with error text if `currentAgentText` was empty.
  - Run test to observe Red.

- [ ] **Task 5: Implementation of Host Message Delta Translator (F-94-2, F-94-4)**
  - Update `translateAgentEnd` in `src/host/message-delta-translator.ts`:
    - Identify `isError` when `event.stopReason === "error"` or `rawMsg?.stopReason === "error"`.
    - Resolve `errorMessage`.
    - If `currentAgentText` is empty and `isError` is true, emit `item.textClose` with `errorMessage` so user sees the message in the transcript.
    - Set `status: "failed"` on `turn.boundary` when `isError` is true (and not aborted).
    - Attach `error: { message: errorMessage }` to `turn.boundary`.
  - Run `node --test tests/error-handling-visibility.test.ts` to verify Green.
  - Verify line budget of `message-delta-translator.ts` stays < 250 lines.

- [ ] **Task 6: Full Verification & Architecture Gate (S8)**
  - Run `npx tsc --noEmit` (0 errors).
  - Run full test suite: `npm test` (all tests passing).
  - Check AP-019 line budgets on all modified files.

- [ ] **Task 7: Ledger and Memory Updates (S9, S10)**
  - Record Cycle 94 findings, fixes, and verification evidence in `docs/arch-improvement/ledger.md`.
  - Record durable lesson in `docs/arch-improvement/memory.md`.
  - Commit and push to `main` per `AGENTS.md`.
