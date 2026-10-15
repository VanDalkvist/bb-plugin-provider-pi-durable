# BB instruction transport parity

## Problem

The ordinary Pi provider maps BB `options.instructions` into a base or appended
system prompt, writes that literal text into scratch files, and passes file paths
to its runner. Durable skipped `options.instructions` and passed the raw
`appendSystemPrompt` string as a CLI file path. The runner silently ignored that
nonexistent path. As a result, the model lost BB's own instructions and could
mistake Pi session discovery for discovery of BB threads.

This was not a missing BB endpoint: `BB_CLI` already exposes `thread list`,
`thread log`, `thread tell`, and `thread archive`. Pi sessions and BB threads are
different namespaces. Do not add a duplicate connector or hardcode a replacement
BB guide inside this adapter.

## Capability assessment

| Candidate | Responsibility | Declared/effective tools | Mutation/network | Write authority | Overlap | Decision | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BB CLI | BB project/thread discovery and lifecycle | bash invokes daemon-managed `BB_CLI` | Reads and authorized lifecycle mutations through BB | Only requested user operations | Existing official BB API | REUSE | Installed `bb guide`, `bb thread --help` |
| Pi Intercom | Live Pi session communication | intercom list/send | Peer messaging | No BB archive authority | Not a BB-thread inventory | REUSE | Session IDs differ from `thr_*` IDs |
| Durable host adapter | Carry BB-owned instructions to runner | Registry → subprocess argv → prompt adapter | Private local scratch files | Explicit fix scope | Ordinary Pi already implements this contract | ADAPT | `runner-prompts.ts`, integration test |

## Fix

- Normalize BB append/replace instructions at the host boundary. Preserve explicit
  `systemPrompt`, `baseInstructions`, and `appendSystemPrompt` protocol values.
- Write literal prompt contents into unique private scratch files (mode 0600).
- Pass paths, not text, to the existing runner CLI. No new prompt content or tool.
- Remove files on runner exit or launch failure; isolate concurrent runners.

## Verification

`node --test tests/bb-instructions-parity.test.ts` exercises the full host path:
BB-shaped turn params → SessionRegistry → RunnerProcess → real CLI parser → real
`createPiPrompt` rendering in a fixture subprocess. No paid model or production
thread mutation is involved. It also checks path-like literal text, permissions,
concurrent file isolation, empty input, and cleanup.

On the fix baseline: 5/5 regression tests; `npm test` 214/214; `npx tsc --noEmit`
and `git diff --check` succeed. Some existing tests intentionally launch runners
without a configured model and print startup errors despite passing assertions;
this is not a model-backed production smoke test.

## Delivery boundary

The local BB installation uses a versioned snapshot with additional workbench
patches. Publishing this change to repository main does not replace that snapshot
or restart already-running sessions. A deployment must preserve those local
patches and rebuild the host bundle. Existing runner contexts are not retroactively
rewritten. Do not replace the installation with a clean upstream checkout or
restart active threads just to apply this source fix.
