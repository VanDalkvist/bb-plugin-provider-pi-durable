# File-change Delta Micro-loop

**User approval:** 2026-10-25, after the subagent-policy fixes, investigate and repair the incorrect file-change deltas shown in the attached screenshot. This is a separate bounded bug loop, not another broad review of the policy feature.

## Completed result

- Fix: `f11f89de3bebbd805579ebd87edc4c617d90d376`; exactly two production adapter files, no BB Core patch.
- Parent full verification: **399 Node + 9 UI = 408 pass**, typecheck/build/dependencies exit 0; targeted native/delta suite **11/11**; runner **143947 bytes**. Source line counts 69/183; tests 160/194.
- S9: narrow Architecture **PASS** and Product **PASS**, reports `2026-10-25-file-change-delta-architecture.md` and `2026-10-25-file-change-delta-product.md`.
- Product scope is public SDK consumption of real captured notifications and native before/after, not a live desktop UI rollout. No install/reload/push/tag/release.
- Parent receipts: `delta-final-verification.json`, `delta-post-build-readback.json`, `delta-targeted-green.log`. A transient dirty CSS readback was rechecked: src/tests/dist match the committed candidate byte-for-byte; no CSS change established.
- Durable lesson: GBrain `docs/research/pi-durable-native-edit-file-change-micro-loop-2026-10-25`, indexed by repo memory and ledger.

## Entry and scope

- Policy implementation fixes: `8cce858`, `9416d0d`. Fresh parent verification: 395 Node + 9 UI = 404 pass; typecheck/build/dependencies exit 0; runner 143947 bytes. Product and architecture targeted closures are both PASS; the original policy gate is closed. Phase A remains read-only until the evidence-based Phase B plan is written and checked.
- Repository: `/Users/vanya/Projects/bb-plugin-provider-pi-durable`; Pi remains 1.3.0, BB SDK remains 0.6.79.
- Screenshot: `/Users/vanya/.bb/thread-storage/thr_3e4z9meeqs/Attachments/image-1792944062046-dc5mcn.png`.
- Source scenario: correction worker `thr_wwgrn2pqdu`, edits around `child-turn-guard.ts` and `session-owner.ts` in `9416d0d`. UI shows grouped file changes and several entries for the same file. Whether fragmentation, stats, patch contents or replay is wrong must be established from actual payloads, not inferred from the screenshot alone.
- Latest explicit model override: use `--provider pi-durable --model google-vertex/gemini-3.8-flash --reasoning-level high` for remaining helpers; user authorized Vertex because Antigravity quota is exhausted.

## Phase A — Root-cause investigation (read-only)

- [x] Read relevant project memory and mandatory architecture/debugging skills.
- [x] Identify the runtime versions/paths actually used by the screenshot worker. Installed plugin has not been updated as part of policy development; distinguish its executed producer from checkout code.
- [x] Retrieve minimal relevant BB/native tool events for the screenshot. Do not copy private transcripts or credentials into the public repository.
- [x] Trace edit arguments → native tool details → runner event adapter → host fileChange deltas → SDK/Core projection. Use installed Pi 1.3 source, public SDK 0.6.79 types and matching BB reference code.
- [x] Compare single edit, multiple regions of one file, and distinct calls/files; start/end captured payloads match. Replay was not implicated; no live history rewrite was performed.
- [x] Reproduce semantic failure with actual producer-shaped input. Validate patch applicability, counts, unique file identity and retained hunks, not only schema acceptance.
- [x] Write `docs/arch-improvement/reviews/2026-10-25-file-change-delta-investigation.md`: evidence, root cause, bounded finding(s), AP rules, fix-now/log-only/blocked, and explicit unknowns.

## Phase A result and triage

Investigation report: `docs/arch-improvement/reviews/2026-10-25-file-change-delta-investigation.md`, owner `thr_squn93nr4e` (Vertex). Real native records and source show the same bug in resident 0.2.52 and current checkout:

1. **P1 / fix-now:** native edit returns a display-only numbered/ellipsized `details.diff` AND a canonical unified `details.patch`. `resolveFileChangeItem` chooses display diff first; BB's valid unified-patch consumer therefore truncates the preview. Choose patch first.
2. **P1 / fix-now:** a native edit call owns one `args.path`; its `args.edits` are regions, not files. `buildToolItemShape` creates one `changes` entry per region, and BB correctly renders each as a distinct file row. Emit one file entry per native edit call; canonical final patch carries every hunk.

The Phase A script is an observational diagnostic, not an automated RED test: it prints buggy output and a hand-constructed corrected hypothesis. Phase C must assert desired behavior against actual production functions. Its command also needs the investigator's BB_THREAD_STORAGE explicitly when run from another thread. Patch applicability was shown; do not claim byte-for-byte equality with a later amended commit without an actual equality assertion.

## Phase B — Selected correction and critical plan check

User-approved direction is the requested bounded investigation-and-repair. Coordinator S7 check: these are adapter contract defects, not a new architecture; no BB core patch, custom renderer, TUI parser, patch reconstruction or global file registry is needed. Original policy S9 gate is closed in both circuits.

**Owned production files:** only `src/host/tool-item-shape.ts` and `src/host/diff-utils.ts`. Remove the now-unused granular-edit interface if appropriate. Keep existing path/kind/status/tool-call identity behavior.

**Test files:** update the obsolete two-entries assertion in `tests/tool-delta-translator.test.ts`; add a bounded `tests/native-edit-file-change.test.ts` (or small focused helpers if necessary to remain <200 lines). No private transcript/SQLite payload in git; generate an equivalent real native producer result on temporary public test content.

- [x] RED: multi-region edit of one path gives exactly one fileChange entry, not one per region.
- [x] RED: actual public Pi 1.3 createEditTool result supplies both TUI diff and canonical patch; translated final change must retain the canonical patch, every separated hunk, correct line counts and line numbers.
- [x] Semantic assertion: applying the translated patch to known before-content yields exact after-content produced by the real edit tool. No moving git ref or private native DB dependency.
- [x] Preserve single-region edit and distinct tool calls on two files; do not coalesce separate calls merely because a path repeats. Existing write/add canonical diff tests remain green.
- [x] Schema-check emitted items in addition to semantic assertions. Missing details may remain unavailable, never fabricate a whole-file patch from snippets.

Save RED logs before production edits, then GREEN. Minimal implementation: one path/update entry in native edit start shape, and prefer `details.patch` over `details.diff` in final enrichment (preserve valid diff-only custom-producer behavior). No changes to native event extraction or replay machinery without new evidence and a plan amendment.

**S7 outcome:** sound and bounded; Phase C approved. Narrow architecture/product acceptance follows this correction only; it must not reopen the policy feature or entire codebase.

## Phase C — Planned correction and verification

- [x] Add a failing regression for the confirmed scenario, save RED output (`thr_squn93nr4e/investigation/red-output.log`).
- [x] Apply only the bounded producer/adapter fix, preserving tool identity, status, real file paths and all edits; no fabricated deltas or UI-only masking.
- [x] Capture GREEN and fresh full tests, typecheck, build and line-budget checks.
- [x] Run narrow architecture/product acceptance for this delta fix only, not a new whole-repository review.
- [x] Update ledger/memory and report actual verification/deployment state.

## Exclusions

No Pi 1.4 upgrade, task graph implementation, settings redesign, BB core patch, installed-cache modification, installation/reload, push/tag/release, broad cleanup, or private raw-event dumps in git. Existing SDK dependency-placement check exit 1 stays a documented exception, never a green result. Changed/new production TS/TSX stays under 200 lines.
