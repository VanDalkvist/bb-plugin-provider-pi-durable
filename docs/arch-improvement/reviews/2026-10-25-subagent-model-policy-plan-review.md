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

Task1 may execute now as a separate bounded migration. Tasks2–10 are BLOCKED until their plan amendment is reviewed. This is not a runtime S9 PASS. No scope expansion to generic provider rewrite, standalone config, role registry, or public release.
