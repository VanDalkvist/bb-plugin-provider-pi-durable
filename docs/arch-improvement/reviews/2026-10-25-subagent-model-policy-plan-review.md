# S7 Critical Plan Review — Subagent Model Policy

Date: 2026-10-25. Plan: `docs/superpowers/plans/2026-10-25-subagent-model-policy.md`.
Baseline: clean main `4d02d4c`, v0.2.52; 330/330 tests and tsc pass.
User approval: implement the agreed scope via arch loop, latest SDK with no legacy; execution plan must live in the repository.

## Task 1 gate — APPROVED after corrections

- Exact SDK0.6.79 and minimum engines SDK>=0.6.79 / BB>=0.47.1 verified against npm and running host.
- Corrected `--package-lock-only` to an actual exact SDK install: verification must run against the new node_modules too.
- Pin native packages/overrides to installed1.3.0 rather than pretend caret1.3.0 prevents1.4 upgrades.
- Add direct current API cleanup in server.ts; no optional probes for unsupported old BB.
- Configuration slice uses manifest contract RED/GREEN, followed by SDK check, tsc, build and full suite.
- No feature logic, live installation, public push/tag/release in this slice.

## Remaining plan corrections — required before Tasks 2–10 execute

- [P1] Runner policy must be scoped to each opened durable runtime, not a module-global mutable singleton shared by independent Harness instances/tests. A runtime-owned holder and explicitly injected getter port preserve isolation. Rule: AP-011/AP-020/AP-034.
- [P1] Native execution must actually use the validated resolver/availability adapter; Task5 must not bypass Task2 by directly assigning configured fields in the transaction. Availability must use real public Models/ModelRuntime methods, not fictitious native `.hasCredentials(provider)`/`.reasoningLevels` fields. Rule: AP-012/AP-025/AP-026/AP-027.
- [P1] Real SDK integration fixture must register the configured model and provide a valid native invocation API/availability port. A test that blindly accepts unregistered mock-provider contradicts no-fallback validation. Rule: AP-028.
- [P2] Runtime policy state must validate record shape, reject downgrade/same-revision conflicts, ack before prompt, preserve existing child admission on replay. Module reset helpers are not production APIs. Rule: AP-013/AP-035/AP-038.
- [P2] Catalog bootstrap RPC must accept explicit host/environment routing and have a real public host RPC composition/lifecycle. Do not run Pi discovery on the BB server or create fake picker IDs. Rule: AP-020/AP-023/AP-026/AP-048.
- [P2] Thinking enum/capability validation must be derived from supported Pi1.3 contracts and mapped at the BB boundary, not inferred from invented fields or unnecessarily restrict native enum. Rule: AP-026/AP-050.
- [P2] Store mutations must serialize CAS+persist+cache update; add concurrent and failed-write tests with a fixed clock. Synchronous revision compare before two async writes alone is not optimistic locking. Rule: AP-023/AP-028/AP-034.
- [P2] Strong typed DTOs and real adapter fixtures instead of expanding production `any` / optional current method probes. Rule: AP-025/AP-026/AP-029.
- AP identifiers in the first draft were mislabeled; the corrected Context Map is normative. Phase descriptions must use actual baseline rule names.

## Execution decision

Task1 was implemented locally in `1deba49`: 332 tests pass, root server now included in tsc, build passes. SDK check exits1 because the CLI requests devDependency placement despite provider-bridge runtime imports; version is correct, deviation retained explicitly. Independent review thread hit a transport timeout; no final review PASS is inferred.

### Parent S7 readback — next bounded slice

The recovery planner saved a 685-line amended plan before a second transport failure. Parent read all amended sections and corrected remaining contradictions directly in the canonical repository plan.

**Tasks2–3: APPROVED** for domain schemas/resolver + serialized KV store and async startup. Pure resolver now consumes real `readonly Model<Api>[]` and native public `getSupportedThinkingLevels`; no fictitious native auth API. Canonical native thinking type includes minimal, strict JSON DTO boundaries, defensive snapshots, fixed clock tests, serialized CAS and failed-write invariants. Startup must be tested pending/error/success and all old server-entry fixtures await async initialization. Get/set are the only new exposed RPCs until catalog routing exists.

**Tasks4–10: still pending targeted seam review**, not blanket approved. Parent corrected identical same-revision idempotence, explicit host route, final S9 naming, and accidental thread-storage handoff instructions. Remaining phase checks include actual registry construction order (Task4/5), real lifecycle terminal events and failed/interrupted semantics (Task7), public picker props/host selection + behavior—not source-string—tests (Task8), and workspace instruction scope (Task9).

### Parent S7 readback — native batch Tasks4–5

Source-backed seam report: `2026-10-25-native-policy-seams.md`. Parent verified runtime-loader, runtime, harness-setup, session-commands, binding-docs and subagent/subagent-docs sources.

**Tasks4–5: APPROVED as one ordered native runtime batch** (factory introduction must accompany required registry injection; no broken Task4-only commit). The canonical plan now includes runtime return wiring, required getter before optional registry parameters, <200-line dispatcher extraction, native execution ACK Doc restored before harness.resume, serialized async persistence-before-cache setter and immutable admission metadata. After existing-child reuse is ruled out, logical admission reads the parent and freezes one latest acknowledged policy before async configured-model validation; inherit need not probe credentials/catalog. It resolves before creation and records that exact snapshot. Existing child/reporter reuse precedes preflight, so replay never switches a child's model.

One seam-review suggestion is explicitly REJECTED: retaining a default-inherit `Subagent` export solely for old fixtures. Migrate the internal test callers to the required factory instead; avoid an unconfigured production bypass. Metadata source values use the existing `ResolvedChildConfiguration` union, not another enum.

Architecture boundary remains BB KV=user settings; native ACK Doc=last acknowledged execution checkpoint in existing Durable SQLite, NOT a new config sidecar. Failed persist leaves acknowledged cache unchanged; identical updates do not write; concurrent writes serialize. New code must prove restore before scheduling and retain owner/Anchor cancellation semantics.

### Native implementation spec correction

`43f9362` initially ignored invalid non-null ACK Doc payloads and silently restored inherit0. Parent spec review flagged P1 (AP-012/AP-013/AP-027): explicit corrupt-runtime-ACK rejection was missing. Follow-up `4ba97b0` adds a genuine failing-then-passing native corrupt-ACK test, typed load error with cause, post-open resource cleanup, direct required Pi1.3 createTask call, and bounded new test files. Independent native quality review now PASS (`2026-10-25-native-policy-review.md`), with 12 focused tests independently rerun by parent and clean tsc. Reviewer P3 on the runner's unnecessary `(cmd as any).policy` alias / cast is selected for canonical-contract cleanup before final delivery; no full feature PASS inferred from 368 tests.

### Parent S7 readback — host batch Tasks6–7: APPROVED

The canonical plan now incorporates source-backed warm/cold owner isolation and native batch-aware lifecycle fixes. Root guard precedes CWD reconciliation/compaction; first/changed policy delivery tracks actual ACK independently from desired options. Actual native child model/thinking are forwarded to BB mirrors; no hardcoded preferred model. A cold child may not pass its composer model as root CLI config (`SessionRegistry.createOrGet` -> buildRunnerArgs -> openDurable root.configure would mutate the physical root). Known parent/composite/binding context must preserve owner identity; non-native CLI children without a native binding remain independent.

Additional source proof: Pi1.3 events.js emits run_end BEFORE submissions in one commit batch. A per-event abort flag is insufficient; child batch pre-scan must match run_end.inputs. A successful answered input wins over an intermediate tool task failure. Late mirror binding currently flushes buffered deltas then synthesizes a second completed boundary in bridge-router; remove this overwrite and deliver one actual terminal outcome. One-shot nonempty admission matching must not swallow real follow-ups or empty task metadata.

These are bounded fixes to agreed host/root/mirror behavior, not a new FSM/graph/Anchor design. Tests must cover exact native batch order, active and early-settled mirrors, owner unchanged, cold reconnect, true child overrides, one generation per admission, and real subsequent turns.

### Parent S7 readback — UI Task8: APPROVED after explicit corrections

Public API proof: `2026-10-25-settings-ui-seams.md`; parent independently read SDK0.6.79 picker/slot/host client/error/testing declarations. Normative corrections are now in Task8: slots.settingsSection takes an object; providerId is inside the concrete picker value; routing context is not available from useBbContext. Shared host contract must be side-effect-free (server may not import host entry). Server route refusals use PluginRpcRefusal invalid, not provider-bridge -32602 or an invented unavailable refusal code. A selected environment with no usable path is an error, not silent global-host fallback.

Public SDK testing exports loadPluginApp and renderSlot(registration, props, options); add only necessary dev peers and real TSX behavior tests, not collector/source-grep-only coverage. Configured Save validates model/level on current preview route; inherit Save remains available without a catalog. Preserve unavailable saved values, drafts on conflicts/errors, and ignore stale route responses. Public native getSupportedThinkingLevels is the authority for capability mapping, including minimal supported by SDK ReasoningLevel:string; no new independent model catalog. Preview scope is not another settings scope.

Implementation is ordered after the current Host6–7 batch so npm/build/artifact writes and commits do not race. Task9 instruction scoping and small canonical runner-command cleanup remain pending; Task10 is the final two-circuit S9, not a prior proposal/slice PASS. This is not a runtime S9 PASS. Keep S8 selected slices separate from final two-circuit verification. No generic provider rewrite, standalone config, role registry, or public release.
