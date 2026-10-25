# S7 Architecture Review: Task 1 SDK 0.6.79 Migration Slice

- **Target commit:** `1deba49` (HEAD of Task 1 migration slice)
- **Scope:** Task 1 of `docs/superpowers/plans/2026-10-25-subagent-model-policy.md`
- **Governing rules:** `arch-rules.md` (AP-010..AP-071), `arch-rules-implementation-review`
- **Date:** 2026-10-25

---

## 1. Verification Evidence & Contracts

1. **SDK Pin & Engines:**
   - `package.json:6-7`: `engines.bb` updated to `">=0.47.1"`, `engines.bbPluginSdk` updated to `">=0.6.79"`.
   - `package.json:27`: `@get-bb/plugin-sdk` strictly pinned to `"0.6.79"`.
   - `package.json:24-26,34-35`: native `@earendil-works/pi-durable`, `pi-coding-agent`, `pi-codemode` and overrides (`chord`, `pi-ai`) strictly pinned to exact `"1.3.0"`, eliminating all carets. Verified via `npm ls`.

2. **Server Typing & Lifecycle:**
   - `server.ts:7,24`: `bb: BbPluginApi` and `deriveProviderOptions(ctx: PluginProviderOptionsContext)` strongly typed from `@get-bb/plugin-sdk`.
   - Obsolete optional chaining probes (`bb.settings?.define?.`, `bb.rpc?.register?.`) removed in favor of direct required methods (AP-012, AP-046).
   - Redundant/invented manual `provider.dispose()` inside `bb.onDispose` removed; core manages provider lifecycle wholesale.
   - Preserves existing `hideThinking` settings and `diagnostics_get` RPC without regression.

3. **Typechecking & Line Budgets (AP-019):**
   - `tsconfig.json:27`: explicitly includes `"server.ts"`. `npx tsc --noEmit` exits `0`.
   - Line counts: `server.ts` (72 lines), `tests/package-integrity.test.ts` (115 lines), both strictly < 200 lines.
   - Doctor app: `manifest.bb.app` remains unadded; Doctor UI not activated.

4. **Documented CLI Deviation (`bb plugin types --check`):**
   - Exit code: `1` (`Move "@get-bb/plugin-sdk" from dependencies to devDependencies`).
   - Disposition: Intentional, documented deviation. Runtime host/bridge code (`src/host/index.ts`, `src/host/delta-translator.ts`) requires `@get-bb/plugin-sdk/provider-bridge` and `/host` under clean `--omit=dev` installs (SawyerHood review blocker, PR #501, Cycle 69). This is NOT a green CLI check and must not be marked green.

5. **Test Assertions:**
   - RED evidence verified in `sdk-migration-red.log` (failed on caret and sdk pin).
   - GREEN package integrity: 6/6 tests pass in `tests/package-integrity.test.ts`.
   - Full suite conformance: 332/332 tests pass in `sdk-migration-test.log`.
   - Build bundle: `npm run build` succeeds cleanly.

---

## 2. Findings

- None (P0/P1/P2: 0).
- [P3] Log-only: `bb plugin types --check` exits 1 due to the host CLI's devDependencies heuristic for client plugins, conflicting with provider-bridge runtime dependency requirements under `--omit=dev`. Documented in `tests/package-integrity.test.ts`.

---

## 3. Architecture Verification & Verdict

- **Passed:** AP-010 (Thin Adapter), AP-012 (Fail-fast direct API calls), AP-019 (Line budgets < 200), AP-026 (Strict DTO/package contracts), AP-028 (Deterministic tests, RED/GREEN evidence), AP-046 (Clean SDK upgrade).
- **Not Applicable:** AP-034/AP-035 (Policy persistence/concurrency deferred to Tasks 2–4).
- **Residual Risk:** None for Task 1; Task 2+ subagent policy changes remain separate slices.

**VERDICT: PASS** (Task 1 SDK migration slice only; NOT full feature S9).
