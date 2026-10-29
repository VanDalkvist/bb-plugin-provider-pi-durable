# PRD: Subagent Mirror Correlation & Independent Child Threads (Cycle 97)

## 1. Problem Statement & Regressions
In Beyond Boundaries (BB), child threads can be created in two distinct ways:
1. **Native Pi Subagent Mirrors (Model A):** Subagents spawned in-process via Pi Durable's `subagent` tool. They share the parent's single runner process and `session.sqlite` database. Their detailed execution streams into a child thread in the BB sidebar, while the parent thread's transcript retains only a clean delegation summary card.
2. **Platform Child Threads (Model B):** Independent worker threads created by users or agents (via BB UI "Child thread" or CLI `bb thread spawn --parent-thread <parent>`). These are autonomous agents with their own independent runner and session lifecycle.

### The Cycle 96 Regression
In Cycle 96 (commit `8058ab6`), `session-registry.ts` assumed that ANY thread with a `parent_thread_id` was a native subagent mirror. When an ordinary platform child thread connected, the registry attempted to match its prompt against `pendingByTask`. When no match was found, it threw a fatal exception:
`Cannot resolve native child conversation for thread <childId> under parent <parentThreadId>`
This crashed all ordinary BB child threads on startup and prevented users or coordinator agents from spawning independent workers. Additionally, matching by raw task string was prone to collision when multiple concurrent subagents executed identical tasks.

## 2. Core Architectural Invariants
1. **Ordinary BB Children Must Work Independently:**
   A thread having a `parentThreadId` (in CLI args or in `bb.db`) must NOT cause it to be captured by the parent's session unless explicit mirror identity is verified.
2. **Deterministic, Explicit Mirror Identification:**
   No guessing based on prompt prefixes, sole candidate heuristics, or raw task strings. A thread is recognized as a native mirror IF AND ONLY IF:
   - It is already registered via `session.registerThread(childThreadId, conversationId)`; OR
   - Its `providerThreadId` is composite (`${sessionKey}:${conversationId}`); OR
   - Its startup prompt contains a valid, versioned adapter mirror envelope.
3. **Canonical Root Session Key in Envelope:**
   The envelope must specify the canonical root `sessionKey` so cold resume of an alias thread re-opens the parent's `session.sqlite` rather than creating a disconnected alias database.
4. **Reserved Protocol Envelope Security:**
   Any input starting with the reserved prefix `[bb:pi-subagent-mirror:` is owned by the adapter protocol. If it is malformed, uses an unsupported version, or targets the root conversation, it must fail typed immediately (fail closed) and NEVER be forwarded to the LLM. Ordinary text that does not start with the reserved prefix remains ordinary.
5. **Clean Parent Transcript via Host-Level Routing:**
   Child events stream to the child thread. The parent timeline retains only the delegation summary card. Child text deltas are filtered at the host `SessionSubagentHandler` routing boundary, NOT in `BBChildEventAdapter` (which would strip the child's own stream).
6. **No Graph Throttle Modification:**
   `RuntimeGraphSource` already implements debouncing (250ms/1000ms max) and structural deduplication. Do not touch UI graph throttling without measured defect evidence.

## 3. Envelope Specification
### Wire Format
```text
[bb:pi-subagent-mirror:v1 session=<sessionKey> parent=<parentThreadId> conv=<conversationId>]
<actualTask>
```

### Parsing Rules
- **Non-reserved:** If `!input.startsWith("[bb:pi-subagent-mirror:")`, `isMirror: false`, `task: input`.
- **Reserved valid:** Matches regex `/^\[bb:pi-subagent-mirror:v1\s+session=([^\s\]]+)\s+parent=([^\s\]]+)\s+conv=([^\s\]]+)\](?:\r?\n)?([\s\S]*)$/u`.
  - `sessionKey`, `parentThreadId`, `conversationId` extracted.
  - `conversationId !== "1"` (root conversation prohibited).
  - Returns `isMirror: true`, `sessionKey`, `parentThreadId`, `conversationId`, `task`.
- **Reserved invalid:** Starts with `[bb:pi-subagent-mirror:` but fails schema (wrong version, missing fields, or `conv === "1"`). Throws `InvalidSubagentMirrorEnvelopeError`.

## 4. Validation & Admission Rules
Before any session attachment:
1. `envelope.parentThreadId` must match actual DB/param `parentThreadId`. Mismatch throws `SessionOwnerConflictError`.
2. `envelope.conversationId` must not equal `ROOT_CONVERSATION_ID`.
3. If parent session is active: `envelope.sessionKey` must match parent session key, and `envelope.conversationId` must belong to that parent session.
4. If thread is an ordinary child (no envelope, no composite ID, not registered):
   Registry provisions a standard independent session (`buildSessionOptions(threadId, ...)`) with its own runner.

## 5. Verification Gates
1. Unit tests for envelope parsing, validation, and stripping.
2. Unit tests for spawner formatting with `sessionKey`.
3. Registry tests:
   - Ordinary child with `parentThreadId` starts independent runner (negative control).
   - Same-task ordinary child does not hijack or get captured by running subagent with identical task.
   - Valid envelope attaches to parent session.
   - Mismatched parent/session throws typed error.
   - Cold resume of child with envelope recovers parent session key.
4. Host event filtering tests verifying parent timeline gets only summary while child thread receives deltas.
5. Full regression test suite (`npm test`) passes with 0 failures.
