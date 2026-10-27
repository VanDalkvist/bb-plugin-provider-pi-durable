# Codemode Generic Provider Parity Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to execute this bounded slice.

**Goal:** Match the built-in BB Pi provider's ordinary codemode tool card, as requested in the user's screenshot.

**Architecture:** Keep codemode as a generic tool with original arguments and output. Remove Durable-only presentation labels, icon and comment-derived headline. Keep hierarchy suppression and delegation presentation unchanged. No renderer, extension state, runtime or transport changes.

**Tech Stack:** TypeScript, BB provider bridge, node:test.

## Scope and worktree

Existing unrelated dirty changes include subagent runtime, package metadata, changelog and generated dist files. Do not stage or publish those changes. No installation or runtime restart in this slice.

## Verification record

- RED: presentation suite failed four assertions due to the existing custom metadata; delegation assertion passed.
- GREEN: presentation + hierarchy suites passed 8/8.
- `npm test`: contracts succeeded; 539 main tests and 43 UI tests passed, zero failures.
- `npm run build`: succeeded; emitted a Node module.register deprecation warning.
- Focused `git diff --check`: passed. Reviewed source diff: removes only codemode presentation helpers and obsolete exports; delegation and hierarchy code unchanged.
- Build regenerated existing dist files from the dirty worktree; none of these generated files belongs in this focused source commit. No plugin installation/restart performed.

## Steps

- [ ] Replace `tests/codemode-presentation-parity.test.ts` with regression coverage for start, successful/error close, schema validity, retained source/output and unchanged delegation presentation. Assert presentation is absent.
- [ ] Run `node --test tests/codemode-presentation-parity.test.ts`; verify failures are caused by the existing custom presentation.
- [ ] Remove codemode-specific helpers and dispatch from `src/host/tool-presentations.ts`, plus obsolete re-exports from `src/host/tool-delta-translator.ts`.
- [ ] Run presentation and hierarchy regression tests, then `npm test` and `npm run build`; retain explicit results. Build output may contain unrelated worktree changes and is excluded from this commit.
- [ ] Inspect the focused diff for preserved delegation and hierarchy behavior, no custom UI, unchanged result/error payloads.
- [ ] Commit and push only this plan, the two production files and the presentation test to main. Report installation separately; do not imply the running plugin has changed.
