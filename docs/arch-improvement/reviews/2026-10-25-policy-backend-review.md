# Architecture Review: Subagent Model Policy Backend Slice (Commit 4754427)

## Purpose & Scope
Independent backend slice review of commit `4754427` (Tasks 2–3 of `docs/superpowers/plans/2026-10-25-subagent-model-policy.md`).
Scope: `src/policy/{types,schema,errors,resolver,store}.ts`, `src/rpc/contract.ts`, `server.ts`, and test adaptations. Not final feature S9 review.

## Findings
- [P3] Evidence: `server.ts:37-55` maps `SubagentRevisionConflictError` (`conflict`) and `SubagentPolicyInvalidError` (`invalid`) to `experimental_PluginRpcRefusal`, but falls through on raw `z.ZodError` or unexpected policy subclasses. Impact: While RPC input is pre-validated by `subagentPolicySetInputSchema`, direct handler calls or unexpected validation errors bubble up as generic 500 crashes instead of typed refusals. Rule: AP-012, AP-022. Fix decision: Add fallback `if (error instanceof z.ZodError)` to map to refusal code `"invalid"`.

## Open Questions
- None. Tasks 2–3 contracts match canonical plan; downstream Tasks 4–10 (runner delivery, child execution, settings UI) are cleanly isolated.

## Verification
- Unit/integration test suites: 356 tests pass (`tests/subagent-policy-*.test.ts`, `package-integrity.test.ts`, `thinking-presentation.test.ts`, `master-parity-conformance.test.ts`).
- Typecheck: `npx tsc --noEmit` exits 0 with zero diagnostics.
- Build: `npm run build` succeeds (`dist/server.js`, `dist/runner/index.js`).
- Concurrency & CAS: Serialized promise queue prevents write race poisoning; CAS verifies `expectedRevision`; cache updates strictly on KV write success.
- Hydration & Fail-Fast: `store.hydrate()` awaited before registering provider/RPC; corrupt KV storage throws `SUBAGENT_POLICY_LOAD_ERROR` and aborts registration.
- Domain Purity: No production `any`, line counts < 200 lines (AP-019), pure resolver maps BB `"none"` ↔ native `"off"`, validates against `getSupportedThinkingLevels`.

## Architecture verification
- Passed: AP-010, AP-011, AP-012, AP-013, AP-016, AP-019, AP-020, AP-022, AP-023, AP-025, AP-026, AP-027, AP-028, AP-034, AP-035, AP-046, AP-050
- Not applicable: AP-014, AP-015, AP-017, AP-018, AP-021, AP-024, AP-029–AP-033, AP-036–AP-045, AP-047–AP-049, AP-051–AP-071 (out of scope for backend store/resolver slice)
- Residual risk: SDK CLI exit 1 on generic devDependency advice is a known intentional deviation for provider-bridge runtime contracts. Downstream runner wiring (Tasks 4–5) and UI picker (Task 6) remain pending subsequent slices.

VERDICT: PASS
