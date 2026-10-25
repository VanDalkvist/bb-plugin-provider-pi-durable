# Pi Durable Runtime Task Graph — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Read the [master loop](2026-10-25-durable-1.4-runtime-graph-arch-loop.md) and pass U/G-UI first. No production plugin reload from its own active turn. Worker/reviewer creation requires operator authorization and Pi Durable / Gemini 3.8 High.

**Goal:** A bounded, read-only, real-time representation of the actual Durable 1.4 task lifecycle in BB's composer context segment.

**Architecture:** Existing Harness -> explicit runtime read model -> typed runner event -> native BB `extension.state` -> public thread events/realtime -> React context-segment renderer. No second Harness, private SQLite query, plugin-host shared-memory assumption, semantic task generator or custom scheduler.

**Tech Stack:** TypeScript/Zod, exact Durable 1.4.0, SDK 0.6.79, BB React primitives/tokens, node:test + official frontend test harness and DOM test runtime.

---

## 1. Gates and deliberately excluded scope

- [ ] Upgrade cycle PASS and local candidate identity confirmed.
- [ ] G-UI approval: operator explicitly authorizes a narrow read-only graph renderer using BB UI primitives and a project-owned clarification of the current no-custom-UI rule. Do not edit AGENTS.md to grant this permission yourself.
- [ ] Rebase this plan onto a coherent reviewed baseline, resolving concurrent app.tsx/server.ts/host/session work without overwriting it.
- [ ] Read exact SDK declarations below before coding. If any symbol/signature drifts, stop and update this plan instead of adding untyped fallbacks.

Not included: message directives/embeds, new side-panel product, full phase-history recorder, forced graph canvas/layout engine, semantic work plans, stop/retry controls, new telemetry SaaS, automatic marketplace release. A graph read must never start/resume/abort tasks.

## 2. Native BB transport — verified seam

SDK 0.6.79 `provider-bridge` declares this delta:

```ts
{
  kind: "extension.state",
  extensionKind: "provider-pi-durable/runtime-graph",
  payload: snapshot
}
```

Provider declaration registers local key `runtime-graph` using `extensionKinds: { "runtime-graph": { state: runtimeGraphSchema } }`. `PluginProviderExtensionKindDeclaration.state` accepts Standard Schema v1; Zod qualifies. The persisted event is `thread/extensionState/updated` with `{ kind, payload, providerThreadId, threadId }`.

Public client read contract:

```ts
const rows = await sdk.threads.events.list({
  threadId,
  types: ["thread/extensionState/updated"],
  order: "desc",
  limit: "100",
});
const unsubscribe = sdk.realtime.subscribe({
  event: "thread:changed",
  threadId,
  callback: onThreadChanged,
});
```

Read only events matching the validated extension kind and current native session/build scope. Use beforeSeq/afterSeq for bounded paging; do not assume the newest extension-state event belongs to this kind. Unsubscribe and abort in-flight fetches on thread/unmount changes. This event-stream route avoids assuming that the host-RPC worker and provider bridge share a process or SessionRegistry.

Evidence: installed `bb-plugin-sdk-provider-bridge.d.ts` extension.state schema; `bb-plugin-sdk.d.ts` PluginProviderExtensionKindDeclaration, ThreadEventsListArgs, ThreadEventsArea, BbRealtime; `bb-plugin-sdk-app.d.ts` thread/extensionState/updated.

## G1.1 — Versioned public DTO and lifecycle meaning

**Boundary:** runner/read DTO. **AP:** 012/013/026/029/038/048/049/050.

**Files:** new `src/runtime-graph/{schema,types,status}.ts`, `tests/runtime-graph-contract.test.ts`, `tests/runtime-graph-status.test.ts`. Keep each TS/TSX file <200 lines; split schema families narrowly if needed.

- [ ] RED: schema rejects cross-session references, unknown lifecycle, invalid numeric IDs, oversized label/result preview, unknown outcomes and future state mislabeled terminal. It accepts native sleeping/until and blocked metadata.
- [ ] RED: outcome `completing/completed` is NOT final success; `abortRequested` is NOT aborted; tool result isError does not rewrite TaskOutcome.
- [ ] Run `node --test tests/runtime-graph-contract.test.ts tests/runtime-graph-status.test.ts`; expect missing module/schema assertions before implementation.
- [ ] GREEN: implement explicit versioned boundary contract (proposed names):

```ts
export type TaskOutcomeName = "completed" | "failed" | "aborted" | "faulted" | "orphaned";
export type LiveTaskStatus = "pending" | "running" | "waiting" | "sleeping" | "completing";
export interface GraphScope {
  sessionId: string;
  rootConversationId: string;
  buildId: string;
}
export interface GraphObservation {
  epoch: string;
  revision: number;
  observedAt: number;
  completeness: "complete" | "limited";
}
```

Task node: stable session-qualified task key, native ID/kind/conversationId/owner, state discriminant and only its corresponding phase/on/policy/until/held outcome, background/abortRequested/blocked, bounded factual label. Conversation node: different entity type and explicit owner edge. Recent receipt: terminal outcome, endedAt, optional tool result error/preview. Missing fields are absent/null with explicit semantics, not fabricated defaults.

- [ ] Build Zod schemas mirroring these discriminants; serialize finite JSON only. Fixed limits: 512 live nodes, 128 recent terminal receipts, labels 160 chars, diagnostic preview 500 chars, packet <=1 MiB. Exceeding limits must report `completeness: limited` plus counts, never claim a full graph. Do not persist raw args, full results or checkpoint payloads in every graph packet.
- [ ] Add pure status projection with exact native status preserved. Essential assertion shape:

```ts
assert.deepEqual(projectTaskState({ status: "completing", outcome: "completed" }), {
  rawStatus: "completing", label: "Завершает дочернюю работу", isFinal: false,
});
```

Define `projectTaskState` and its input/output types in status.ts; add exhaustive switch and no success default. Result error is a separate badge.

- [ ] Re-run focused tests and typecheck; commit only DTO/status slice.

## G1.2 — Single-Harness projection, ownership and receipts

**Boundary:** existing runner/public Durable APIs. **AP:** 010/013/019/023/032/033/034/035/038/049.

**Files:** new `src/runner/runtime-graph-{source,scope,receipts}.ts`; modify `runtime.ts` / `runtime-types.ts` through a narrow owned source; new `tests/runtime-graph-{source,ownership,receipts}.test.ts` and bounded fixture support.

- [ ] RED: native graph + conversation records produce exact owner/wait edges; nested codemode, root generation successors and background child conversation remain correctly placed. Fork parent is not ownership; unrelated ownerless conversations do not leak into a child thread scope.
- [ ] RED: a node disappearing during debounced updates becomes a reconciliation entry until its true receipt is loaded. Failed/aborted/faulted/orphaned remain exact; fast create+terminal between UI frames is recoverable from committed records. Empty graph settles display without fake task success.
- [ ] RED: reconnection of a native child after its anchor terminal uses persisted ConversationRecord.owner/binding identity; no fuzzy task-text identity and no alias borrowed solely from BB parentThreadId.
- [ ] Run `node --test tests/runtime-graph-source.test.ts tests/runtime-graph-ownership.test.ts tests/runtime-graph-receipts.test.ts`; expect missing source/correlation behavior.
- [ ] GREEN: source observes the already open Harness taskGraph/watchTaskGraph and existing commit publications. Register/detach observers with explicit lifetime. Use public getTask/scanTasks/conversation records to reconcile terminal receipts; never run another Harness for inspection.
- [ ] Cache read projection only. On reconnect/reopen rebuild bounded recent receipts by public cursor scan, rather than pretend a process-local Map is durable history. Maintain settled outcome separate from result.isError. On receipt read failure emit a typed observation error/retry condition, never completed.
- [ ] Preserve all live nodes within limits, including bb.subagent-anchor/reporter/courier tasks; show custom task kinds as recorded. State counters include scope and limited flag. `waiting.on` is a list of references; distinguish unresolved/live/terminal rather than label on.length as actual outstanding work.
- [ ] Timestamps: lifetime from actual startedAt to endedAt/now includes waits; execute duration from result.durationMs. No phase segments reconstructed from latest checkpoint. No earlier timestamp invented for old records.
- [ ] Coalesce UI publications at 250 ms with a maximum publication interval under sustained updates, while authoritative receipt collection continues for every relevant commit. Flush final empty/live-status transitions on drain. Do not starve publishing by resetting a trailing debounce indefinitely.
- [ ] Re-run focused tests with controlled clock, restart and bounded-limit fixtures; prove no scheduler/resume calls by observation path; commit.

## G2 — Native extension state and public client read seam

**Boundary:** runner -> host provider bridge -> BB store -> frontend SDK. **AP:** 016/021/026/028/032/038/040/041/043/045/048/059.

**Files:** new `src/runner/runtime-graph-event.ts`, `src/host/runtime-graph-delta.ts`, `src/ui/runtime-graph/{read,subscription}.ts`; modify `src/runner/index.ts`, wire contracts, `src/host/delta-translator.ts`, `server.ts`; new `tests/runtime-graph-{bridge,public-events,reconnect}.test.ts`.

- [ ] RED: test actual bridge `threadDeltaSchema` acceptance and provider extension schema validation. Wrong session/thread/native child mapping is refused, not retargeted. Tests cover epoch restart, duplicate/reordered/stale revisions and limited snapshot.
- [ ] Run `node --test tests/runtime-graph-bridge.test.ts tests/runtime-graph-public-events.test.ts tests/runtime-graph-reconnect.test.ts`; expect unknown runner event/extension schema absence before implementation.
- [ ] GREEN: runner emits typed `runtime_graph_snapshot`; host delegates to a pure narrow delta mapper:

```ts
return [{
  kind: "extension.state",
  extensionKind: "provider-pi-durable/runtime-graph",
  payload: snapshot,
}];
```

Register exact schema under provider extensionKinds.state. Host targets only authorized current BB root/native child binding; emit separately filtered scope to a child alias or return explicit not-yet-available state. Never deliver the whole session graph to an unrelated thread merely sharing parentThreadId.

- [ ] Client `read.ts` uses public threads.events.list, checks row.type and data.kind, validates payload, chooses latest epoch/revision for native scope and pages at most five pages of 100 events using beforeSeq. Return explicit unavailable/limited-history rather than assume no tasks if pagination cap is reached. Do not use private BB DB tables or an in-memory map in a different host process.
- [ ] `subscription.ts` subscribes through sdk.realtime to this thread, coalesces invalidations, fetches snapshot at mount/reconnect, cancels old-thread reads and ignores stale responses. Duplicate signals do not duplicate nodes. Unmount removes listeners and timers. Observation status is separate from task lifecycle.
- [ ] **Seam proof gate:** verify in a disposable BB/test host that extension.state while active AND while session idle is persisted, publicly readable and emits the necessary thread invalidation. A passing DTO unit test is insufficient. If this fails, STOP and re-plan transport; do not silently add a polling daemon, loopback server, undocumented event, or shared-memory assumption.
- [ ] Measure a synthetic 100-task burst: convergence within 1 s after final authoritative commit under the test clock; no unbounded read backlog; no more than four normal snapshot publications/s; identical snapshots dropped; bounded body and history. Record payload bytes, event growth and rendering cost. If sustained persistence cost is excessive, stop for a measured transport revision rather than approve an unbounded event log.
- [ ] Remove the legacy automatic runtime `tasks_snapshot -> planSteps` producer once context-segment delivery is verified; native semantic plan rendering elsewhere remains supported. Test no duplicate runtime task list. Do not restore codemode parentRef that earlier tests intentionally suppress.
- [ ] Re-run relevant tool-result/codemode hierarchy/root-child suites plus contract tests; commit.

## G3 — BB context segment + stable tree/inspector

**Boundary:** approved UI composition only. **AP:** 010/019/051/052/053/054/055/063/064/068/069/070.

**Files:** new `src/ui/runtime-graph/{segment,tree,node-row,details}.tsx`, `src/ui/runtime-graph/{selection,format}.ts`, new `tests/runtime-graph-{ui,interaction,empty}.test.tsx`; modify app.tsx and package.json bb.app if not already registered. Narrowly extract unrelated Doctor/settings composition so app.tsx stays <200 lines; do not remove another feature.

- [ ] RED: official SDK frontend harness mounts context segment; summary displays real counters/scope, onToggle reveals details, tree retains exact native status/phase/kind and stable IDs. Bad packet, empty/new thread, unsupported provider, disconnected/reconnecting and limited snapshot have explicit states.
- [ ] RED: test keyboard focus, collapsed descendants/error summary, selected node retained across updates, user scroll not hijacked, result error separate from task lifecycle, no generation hidden as a fictitious semantic phase, reduced-motion and theme tokens.
- [ ] Run the new TSX tests with the repository's official frontend harness + DOM setup; if absent add explicit test-only dependencies and a separate `test:ui` command, not source-string-only tests. Record RED assertion and expected result before rendering code.
- [ ] GREEN: register the native slot:

```tsx
app.slots.experimental_threadContextSegment({
  id: "runtime-graph",
  title: "Ход выполнения",
  group: "2_runtime",
  summary: RuntimeGraphSummary,
  details: RuntimeGraphDetails,
  useVisible: useRuntimeGraphVisible,
});
```

Define all named components/hooks in the listed files. Props threadId/projectId/environment/isExpanded/onToggle follow SDK; environment null is not equivalent to no graph. Resolve actual provider metadata rather than invent providerId on slot input.

- [ ] Render details only when isExpanded, with bounded height and independent scrolling. Solid owner lines, explicit wait links on selection; conversation entities styled as groups, not fake tasks. Optional simple time bars are lifetime only; no chart library/graph-layout dependency for v1.
- [ ] A selected node opens one bounded inspector without changing the entire tree's row heights; on narrow width use a separate lower inspector area. Preserve selection/expansion across revisions of same scope; reset on actual native epoch/scope change. Following active work is an opt-in UI setting, not forced scrolling.
- [ ] Use existing BB primitives/icons/tokens, subtle background/shadow hover, no border-color hover, text+icon status. No prompts, model API calls, stop/retry commands, raw secrets/arguments or new source of truth in UI.
- [ ] Frontend tests, SDK scan, TypeScript and build PASS; commit.

## G4 — Acceptance, isolation and local-only activation

- [ ] Run complete backend and frontend tests, `bb plugin types --check`, `npx tsc --noEmit`, `npm run build` in isolated candidate.
- [ ] Architecture reviewer: AP gates, line budgets, public-only imports, no second Harness/DB schema dependence, exact lifecycle/result separation, disposal/limits and identity access.
- [ ] Product reviewer (black box, no source/diff): same existing thread, live generation + parallel/nested tools, foreground/background subagent, compaction, sleeping/retry, request abort vs actual terminal, result error vs runtime failure, empty graph, lost connection/reconnect, repeated refresh and cold child view. Capture actual UI + public IDs/version evidence without secrets.
- [ ] Both reviewers return PASS; any P0/P1/P2 blocks. Distinguish planned tests from executed tests in review artifacts.
- [ ] Local candidate activation follows G-LOCAL again if already running on a previous local build: quiet boundary, version/build identity, no dev-watch hot reload across all active threads, no market update.
- [ ] Update master/ledger/GBrain and list residual risks. Public push/tag/marketplace switch remains a separate operator gate.

## Requirement coverage

| Requirement | Slice |
|---|---|
| Actual Durable state and phase, including 1.4 sleep/blocked | G1.1/G1.2 |
| No false completed, correct tool result error | G1.1/G1.2 |
| Root/child ownership and wait edges | G1.2/G2 |
| Survives refresh/reconnect, no imaginary live status | G2 |
| Native composer integration, stable informative UI | G3 |
| No LLM directives or shadow scheduler | G1/G2/G3 |
| Existing user threads safe and marketplace unchanged | upgrade U4 + G4 |
| Independently proved end-to-end behavior | G4 dual S9 |
