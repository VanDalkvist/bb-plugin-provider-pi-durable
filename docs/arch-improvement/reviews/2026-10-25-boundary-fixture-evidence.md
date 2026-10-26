# R5 / exact 1.4 implementation evidence — before independent S9

Scope: the four agreed adapter seams (wire events, commands, mirror routing/session ports, Durable read view/storage). This is implementation evidence, NOT a product or architectural PASS.

## Executed checks

- Full integration: **441 Node + 9 UI = 450 pass**, zero failed. Receipt: `thr_ct3kk9xne6/u1-r5-full-final.log`.
- Source `tsc --noEmit`: exit 0; `tsconfig.contract-tests.json`: exit 0. The latter compiles factories, positive/negative calls and **64 direct adapter consumer suites** plus their split scenarios. Concrete roster is the config's include list; AST import inventory receipt: `r5-consumer-roster.json`.
- `npm test` executes the contract compiler AND `check-negative-contracts.mjs`. The latter removes one suppression in a virtual compiler host, observes an actual TS2322 rejection, never modifies source. A weakened fixture produced genuine unused-directive failures during development: `Omit` of the command DTO's extensible index signature lost known field types; replaced with `Partial<RunnerCommandPayload> & {type?: never}`.
- AST import graph: **108 source files / zero SCC**. No runtime-deadlock claim.
- New/touched TS/TSX, including tests, remain strictly <200 lines. Scenario splits preserved the literal test inventory and all runtime assertions; shared support functions extracted once, not copied.
- Build: `npm run build`, exit 0; artifacts `dist/{server,app,host}.js` and `dist/runner/index.js`.
- All five Pi packages resolve exactly **1.4.0**, SDK remains **0.6.79**. `npm audit`: **0 vulnerabilities** after Zod 4.6.6 / Undici 8.12.2 patch updates.
- `bb plugin types --check`: **exit 1**, explicit package-placement diagnostic only: pin and host both 0.6.79; CLI asks to move SDK to devDependencies. Existing standalone-provider runtime requirement and package-integrity test require dependencies; NOT silently changed, NOT reported as an all-green command.

## Meaningful changes / truthful regressions

- Canonical factories use actual Zod-inferred DTOs, native record types and real session/registry ports. No `any` / `unknown as DurableView` / fabricated full PiThreadSession assertion at those four seams.
- Positive integer fixture constructors validate erased nominal IDs; the one generic wire assertion is AFTER complete Zod parsing and discriminator equality, not a partial-payload cast.
- Actual SessionRegistry ownership tracking replaces private map injection; replacing a different live owner is refused. RED/GREEN: `r5-owner-conflict-red.log`, session-port tests.
- Actual consumers of optional `agent_end.message` require an explicit assistant schema, not unknown passthrough. Runtime RED/GREEN receipt: `r5-known-metadata-red.log`, runner-wire-metadata test.
- Codemode fixture now runs the **real native Harness, transactions and nested tool tasks**, with a public keyless faux model and a real loaded extension. Removed manual fake ToolExecutionApi/document storage, not test coverage. Actual native error contract: a schema-bearing Bash exit 42 resolves its structured value; schema-less missing-file errors throw. Previous fake wrongly stripped structured errors. Genuine assertion RED: `r5-codemode-native-red.log`; all nine journeys now execute natively.
- Other impossible test packets were repaired, not normalized in production: required text index/content/assistant role, complete native assistant records, valid command discriminator. Missing command discriminator is tested at the real decoder. Actual SDK-parsed assertions use `resultText` / `key.parentRef`, not unsupported stripped extra fields.
- Real 1.4 courier tests: persisted sleepUntil checkpoint/deadline and same ID after reopen; actual reporter reuses a sleeping courier; all nonterminal statuses including completing are not idle.

## Explicit exceptions OUTSIDE the four selected payload seams

These are NOT claimed eliminated or evidence of full native SDK conformance:

| Location | Why retained / residual risk |
|---|---|
| `src/runner/runtime-controller.ts`, legacy compaction hook payloads | Legacy coding-agent preparation/entry shapes are still adapted with assertions; native Durable compaction remains authoritative and hook failures are explicit safe diagnostics (R3). Exact legacy hook payload fidelity is not proven by this four-seam fixture project. |
| `src/runner/extension-bridge.ts`, headless UI/Theme stubs | Terminal-UI compatibility outside these four payload seams; extensions requiring a real interactive UI are not verified. |
| `tests/subagent-courier-delivery*.test.ts` | Legacy native TaskRuntime/ToolExecutionApi algorithm scenario stubs, not adapter DurableView or SQL-storage fixtures. They are not claimed to prove scheduler/transaction conformance; real Harness courier/reporter tests separately cover the 1.4 API/lifecycle. |
| Native `AgentEvent` producer-input stubs across adapter tests | Upstream event input scenarios are distinct from the adapter's validated outbound wire contract; incomplete native test inputs are not evidence of upstream SDK admission compatibility. Canonical wire inputs and owned read views are compiled/validated. |
| `tests/cwd-isolation.test.ts`, actual runner launch options | A typed lifecycle-only private-field inspection of an ACTUAL runner, using its constructor-options type, not a fabricated runner/session. Rename risk causes a runtime test failure. |
| Actual-session private event-delivery hooks in interruption/mirror tests | Typed RunnerEvent input on real constructed sessions, not partial SDK class casts. Private method rename risk remains visible in runtime tests. |

Reviewers must assess these residuals rather than infer blanket SDK type safety from a cast count.

## Operator and deployment boundaries

- Latest user correction governs: preserve all work; no synthetic migration/restore workflow prerequisite. Already written regression tests stay; no original user session is opened/copied/migrated by this implementation.
- CLI independently reports Pi **1.4.0**. Read-only installed source receipt still resolves plugin **v0.2.52 / 4d02d4c7aefd**. Checkout version, CLI version, installed artifact and resident process are DIFFERENT claims.
- No install/reload/remove/restart/tag/marketplace action executed. Resident generation remains unverified.
- Runtime graph feature is the subsequent cycle in the master plan; UI-policy and live transport gates are not waived by these backend checks.
