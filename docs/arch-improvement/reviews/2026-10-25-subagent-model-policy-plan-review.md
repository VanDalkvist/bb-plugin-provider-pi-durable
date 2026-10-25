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

**Tasks4–5: APPROVED as one ordered native runtime batch** (factory introduction must accompany required registry injection; no broken Task4-only commit). The canonical plan now includes runtime return wiring, required getter before optional registry parameters, <200-line dispatcher extraction, native execution ACK Doc restored before harness.resume, serialized async persistence-before-cache setter and immutable admission metadata. New child preflight fetches native available models / parent snapshot, then captures one latest acknowledged policy and resolves before creation. Existing child/reporter reuse precedes preflight, so replay never switches a child's model.

One seam-review suggestion is explicitly REJECTED: retaining a default-inherit `Subagent` export solely for old fixtures. Migrate the internal test callers to the required factory instead; avoid an unconfigured production bypass. Metadata source values use the existing `ResolvedChildConfiguration` union, not another enum.

Architecture boundary remains BB KV=user settings; native ACK Doc=last acknowledged execution checkpoint in existing Durable SQLite, NOT a new config sidecar. Failed persist leaves acknowledged cache unchanged; identical updates do not write; concurrent writes serialize. New code must prove restore before scheduling and retain owner/Anchor cancellation semantics.

**Tasks6–10 remain pending seam-specific readback** (actual mirror model + first policy acknowledgement, real lifecycle outcome sources, public picker/routing/UI behavior, instruction scoping). This is not a runtime S9 PASS. Keep S8 selected slices separate from final two-circuit verification. No generic provider rewrite, standalone config, role registry, or public release.
