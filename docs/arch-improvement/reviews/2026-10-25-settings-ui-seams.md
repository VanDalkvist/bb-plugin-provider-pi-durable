# S7 Bounded Seam Review: Settings UI & Catalog Bootstrap (Task 8)

Date: 2026-10-25. Plan: `docs/superpowers/plans/2026-10-25-subagent-model-policy.md`.
Scope: Bounded architectural seam proof for Task 8 (BB Settings UI, host RPC composition, catalog bootstrap, and test harness).

## 1. Exact RPC Composition File & DTOs (AP-010, AP-012, AP-020, AP-023)

- **Host Contract & Entry Composition (`src/host/index.ts`):**
  - Export composite `subagentHostContract`:
    ```typescript
    export const subagentHostContract = {
      ...experimental_nativeRootsHostContract,
      subagentCatalogBootstrap: {
        input: z.object({ cwd: z.string().min(1).optional() }).strict(),
        output: subagentCatalogBootstrapOutputSchema,
      },
    } as const satisfies PluginRpcContract;
    ```
  - `experimental_defineHostEntry` registers `handlers: { resolveNativeRoots: ..., subagentCatalogBootstrap: ... }`.
  - Preserves existing `export const experimental_providerBridge = experimental_defineProviderBridge(...)` and `teardown()` process signal bindings.
- **Host Handler Catalog Lifecycle (`src/host/index.ts`):**
  - Instantiates a fresh `const catalog = new ModelCatalog(input.cwd)` per call (NOT `getSharedCatalog`, no long-lived state).
  - In `try / finally`: awaits `catalog.listModels()`, maps descriptors to `availableModels` and `defaultProfile`, cleanly calls `catalog.close()` in `finally`.
  - AbortSignal from `context.signal` cleans up runner on timeout or cancellation without leaking orphan processes. Empty/offline catalog returns `{ availableModels: [], defaultProfile: undefined }`.
- **Server RPC Contract & Route Validation (`src/rpc/contract.ts`, `server.ts`):**
  - Contract: `subagent_catalog_bootstrap` input `{ hostId: z.string().min(1), environmentId: z.string().min(1).optional() }`.
  - Server validation: if `environmentId` given, awaits `bb.sdk.environments.get({ environmentId })`. Asserts `env.hostId === input.hostId` (rejects mismatch with `-32602`), resolves `cwd = env.path ?? undefined`.
  - Host call: `const client = bb.hosts.experimental_client({ contract: subagentHostContract }); await client.call("subagentCatalogBootstrap", { cwd }, { hostId: input.hostId, timeoutMs: 30000 })`.

## 2. UI Host/Environment Selection & Public SDK APIs (AP-011, AP-026, AP-027)

- **Public SDK Area Reads via `useSdk()` (`@get-bb/plugin-sdk/app`):**
  - `sdk.system.config()`: returns `SystemConfigResult` with `primaryHostId: string | null` (`systemConfigResponseSchema:11090`).
  - `sdk.hosts.list()`: returns `HostListResult = Host[]` with `id: string, name: string, status: "connected" | "disconnected"`.
  - `sdk.environments.list()`: returns `EnvironmentListResult = Environment[]` with `id: string, name: string | null, hostId: string, path: string | null, status: "ready" | ...`.
- **Primary Routing & Scope Policy:**
  - Initial routing resolves `primaryHostId` from `sdk.system.config()`, fallback to first connected host from `sdk.hosts.list()`.
  - BB KV `subagent.policy.v1` is strictly global per BB plugin/server. Host and optional environment selectors serve solely as a **Preview Scope** for catalog discovery.
  - Optional environment dropdown is required in UI to pass `environmentId` to `subagent_catalog_bootstrap` and picker `routing: { kind: "environment", environmentId }`, allowing `ModelCatalog` to discover workspace-scoped models (`.pi/` settings and `workspaceModelScope`).

## 3. Catalog Metadata, Preview Profile & Actionable Invalid State (AP-013, AP-027, AP-050)

- **Capability Shape from Existing `ModelCatalog`:**
  - `ModelCatalog.listModels()` returns `AvailableModelDescriptor[]` containing `id`, `model`, `routeProviderId`, `defaultReasoningEffort`, `supportedReasoningEfforts`, `isDefault`.
  - Resolver / picker maps BB reasoning `"none"` ↔ Pi thinking `"off"`.
- **Inherit Mode Preview (Zero Persistence):**
  - When `mode === "inherit"`, `experimental_ProviderModelPicker` is `disabled={true}`. Displays `configuredProfile` if previously set, or bootstrapped `defaultProfile` preview without writing to KV. Subtitle explicitly states: "Модель родителя; сохранённая модель сейчас не используется".
- **Actionable Invalid Profile (No Auto-Replacement):**
  - If stored `configuredProfile.model` is not in `availableModels` on the chosen host/env, it is NOT silently replaced with the first available model. Shows an invalid warning banner; "Сохранить" is disabled until user explicitly picks an available model.
- **Draft vs Applied & CAS Conflict:**
  - Form isolates `draftPolicy` from `appliedRecord.policy`. "Сохранить" enabled only when `isDirty && isConfiguredValid`.
  - On `REVISION_CONFLICT`: re-fetch `appliedRecord` via `subagent_policy_get`, preserve user's `draftPolicy`, display retry notice.

## 4. App Harness, Dependencies & Test Strategy (AP-019, AP-021, AP-028)

- **SDK 0.6.79 App Registration Correction:**
  - `app.slots.settingsSection` requires registration object: `{ id: "subagent-model-policy", title?: string, description?: string, component: ComponentType<PluginSettingsSectionProps> }` (plan previously assumed raw component).
- **Missing React/DOM Peer Dependencies:**
  - `package.json` lacks `@testing-library/react`, `react-dom`, `@types/react`, and `jsdom`.
  - `node_modules/@get-bb/plugin-sdk/dist/testing/app.js:2732` has top-level ESM `import { act, render } from "@testing-library/react"`; importing `@get-bb/plugin-sdk/testing/app` fails at runtime with `MODULE_NOT_FOUND`.
  - DO NOT install missing packages (prompt constraint: inspect only).
- **Deterministic Test Harness Recommendation:**
  - Unit test `tests/ui-settings-contract.test.ts` executes in standard Node test runner (`node --test`), preserving all 356 baseline tests.
  - Tests contract: `definePluginApp` collector contract verification, slot registration object, DTO converters, draft state transitions, conflict handling, and invalid-profile validation.
  - Manifest & TypeScript: `package.json` sets `"bb": { ..., "app": "./app.tsx" }`. `tsconfig.json` adds `"app.tsx"` to `"include"`. Old `DoctorView` is removed; `app.tsx` solely hosts `SubagentSettingsSection`.

VERDICT: Task 8 SDK UI & catalog seam proof verified against installed 0.6.79 dts; ready for root plan amendment.
