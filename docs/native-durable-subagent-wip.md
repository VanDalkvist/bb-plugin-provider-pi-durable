# Native Durable subagents as BB child threads — work in progress

> **Not ready to merge or activate.** This is a reviewable, historical-base implementation candidate for native Pi Durable subagent visibility in Beyond Boundaries. It is based on `v0.2.11` (`1b89f6a`), while upstream `main` had reached `v0.2.22` (`38462fd`) when prepared. A port and conflict resolution against current `main` are required. Do not run the live plugin based on this branch.

## Intent and present implementation

The upstream native Subagent remains the only creator and executor of a child. A child intent may reserve an empty BB-visible slot; an exact native submission and its stored input are required before a scoped credential can be redeemed. The adapter does not submit a second child task or manufacture a result. Discovery of an existing child, opening/closing a view, and transcript projection are observation paths; they must not implicitly resume execution. A retained root owns the Durable scheduler; attached BB child views share that owner instead of starting a competing scheduler.

The candidate includes route/credential validation, root launch attestation, one retained owner with scoped views, native child discovery, BB slot synchronization, private transport, transcript projection, disconnection/re-attachment, and memory/injected regressions. Root, child, and sibling identities must not be conflated. In particular, a creator `pi.tool` task ID is **not** the child's execution task ID and must never be cancelled as a substitute for child stop. A stop marker does not itself establish terminal completion.

V1 deliberately does not support fork/checkpoint-preserving child identity, arbitrary nested native children, or a general follow-up channel. Cross-process BB slot concurrency without an authoritative compare-and-swap and mutable prompt-file time-of-check/time-of-use remain risks. Existing unit fixtures and compile checks are not evidence of a live BB host, model, provider, process, socket, or persisted-store flow.

## Blocking admission gap

The installed `@earendil-works/pi-durable` **1.0.4** submission path resumes scheduling before committing a new root input. A valid root prompt can fail on a pre-commit storage operation while restored root, child, and sibling tasks already execute. The adapter's command acknowledgement and local `executionStarted` flag may remain false, but neither reverses those task handler entries. The isolated [memory-only reproduction](native-durable-subagent-admission-proof.md) asserts this behavior using public SDK APIs, injected `MemoryStorage.mintId()` failure, and pure synthetic tasks; it does not create an application child or contact a provider.

Maintainer input is needed on a supported public SDK operation that atomically admits the root input before any restored execution becomes eligible (or an explicitly changed acceptance contract). A private scheduler patch, fabricated submission transaction, hiding task kinds, or a second BB scheduler is not a safe substitute. Until the SDK boundary is settled and independently reviewed, the implementation remains **BLOCK** regardless of passing local tests.

## Review and completion checklist

1. Port this historical-base draft against current upstream `main` without losing changes made since `v0.2.11`. Several host/runner files conflict under a dry-run three-way extraction. The branch is not claimed to be mergeable yet.
2. Resolve the SDK admission contract and add a regression: a valid text input rejected before commit must yield zero committed root submissions **and zero restored handler entries**, while accepted retry, cancellation, sibling isolation, and restart behavior remain sound.
3. Reconcile unrelated baseline/extension SDK compatibility with the current upstream implementation; do not copy an older extension lifecycle over upstream's newer code. On this historical base, a safe memory/injected 20-file test selection passed 118/118, but no-emit typecheck currently reports seven baseline SDK-compatibility diagnostics. Neither proves feature acceptance.
4. Obtain independent integrated review and separate permission for any real BB/provider/process/socket/persistent-store smoke test. No build, installation, deployment, or live activation is part of this draft.

The exact bounded, memory/injected 20-file check used on this extracted branch (118 passed, 0 failed) was:

```sh
timeout 60s node --test \
  tests/bb-event-adapter.test.ts tests/bridge-error-handling.test.ts \
  tests/native-child-authority.test.ts tests/native-child-bb-sync.test.ts \
  tests/native-child-discovery.test.ts tests/native-child-host-service.test.ts \
  tests/native-child-inspection.test.ts tests/native-child-transport.test.ts \
  tests/native-child-views.test.ts tests/native-root-launch-attestor.test.ts \
  tests/native-server-admission.test.ts tests/native-view-discovery.test.ts \
  tests/native-view-registry.test.ts tests/native-view-router.test.ts \
  tests/native-view-session.test.ts tests/prompt-adapter.test.ts \
  tests/runner-process-termination.test.ts tests/runtime-controller.test.ts \
  tests/session-commands.test.ts tests/shared-owner.test.ts
```

Dependencies were already present through a **local, read-only `node_modules` link** into the isolated checkout; that link was neither committed nor published. No dependency installation, build, full `npm test`, `ModelRuntime.create()`, or live model/provider/application-child/process/socket/persistent-store check was performed. This 118/118 result does **not** resolve the SDK admission failure or the seven no-emit diagnostics above.

The public issue and Draft PR description should explicitly link this blocker and describe the remaining integration work. The branch is a proposal for collaboration, not a ready-for-merge fix.
