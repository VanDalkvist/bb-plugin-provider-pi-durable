# Active Tool Loadout & Prompt Parity (Cycle 98) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix issue #32 by connecting Extension API active tool selection (`pi.setActiveTools` and `before_agent_start.systemPromptOptions.selectedTools`) directly to Pi Durable's native `AgentDoc.modelTools`, preserving `promptSnippet`/`promptGuidelines` across tool adaptation, eliminating ~55k tokens of bloated prompt prefix on thread start, strictly adhering to canonical Codemode architecture (`agent.callable` vs `agent.tools`), eliminating silent fallbacks and empty catches, and ensuring full persistence across session reopen/resume without breaking Codemode, Subagents, or BB child mirrors.

**Architecture:** 
1. **Model Tools vs. Callable Tools:** `AgentDoc.modelTools` in `@earendil-works/pi-durable` controls ONLY the tools declared directly to the LLM API and listed in the prompt `<tools>` section (`agent.tools`). It does NOT touch `agent.callable`, which contains all registered tools with `callers` including `"tools"`. Codemode scripts execute against `agent.callable`, so restricting `modelTools` via `tool-diet` preserves 100% of Codemode's script-calling and `searchTools()` capabilities while slashing the prompt prefix by ~55k tokens.
2. **Canonical Prompt Invariant (No Fallbacks):** Strictly match upstream `@earendil-works/pi-coding-agent` (`system-prompt.ts:137–142`): tools with a `promptSnippet` are listed in `<tools>` as `- ${name}: ${snippet}`. Tools WITHOUT a `promptSnippet` are NEVER listed in the text prompt (they are passed to the model via the API's `tools` JSON schema parameter). All arbitrary fallbacks (`?? t.description` and bare `- ${name}` bullets) are completely eliminated.
3. **Dual-Channel Hook Reconciliation:** Mirror upstream `agent-session.ts:1935–1946`: if `before_agent_start` explicitly mutates `systemPromptOptions.selectedTools`, that edit wins; otherwise, the live loadout from `getActiveToolNames()` (reflecting any `pi.setActiveTools()` calls) governs. The resolved set is applied via `conversation.configure({ modelTools })`.
4. **Reopen/Resume Hydration:** On session resume, read `rootAgent.tools` from SQLite `AgentDoc` and hydrate `ExtensionRunner.activeTools` immediately, guaranteeing zero-turn, zero-rewrite persistence.
5. **Clean Error Handling & No Empty Catches (AP-012, AP-022, AP-024):** Eliminate all empty `catch {}` blocks in the runner lifecycle; log structured warnings or fail fast with typed errors.

**Tech Stack:** TypeScript, Node.js 24, `@earendil-works/pi-durable` 1.4, `@earendil-works/pi-coding-agent` 1.4, TypeBox, Node Test Runner.

---

## Architecture Context Map

- **Stage:** prod
- **Source docs:**
  - `docs/arch-improvement/ledger.md` (Cycle 97)
  - `docs/arch-improvement/memory.md`
  - GitHub issue VanDalkvist/bb-plugin-provider-pi-durable#32
  - Upstream Pi specification: `packages/durable/docs/spec.md`, `packages/coding-agent/src/core/system-prompt.ts`, `packages/coding-agent/src/core/agent-session.ts`
- **Critical AP gates:**
  - AP-010: Single Source of Truth (`AgentDoc.modelTools` in SQLite is the sole authority for model tools).
  - AP-011: Loose coupling & high cohesion (runner components coordinate through typed interfaces).
  - AP-012: Fail-fast and deterministic error handling (no silent fallbacks, no swallowed exceptions).
  - AP-019: Line budget compliance (< 200 LOC per file, < 250 LOC for complex coordinators and test files).
  - AP-020: Clean Architecture boundaries (ExtensionRunner actions talk to controller/bindings, not raw globals).
  - AP-022: Typed errors and explicit exception handling (structured diagnostics, no empty catches).
  - AP-024: Observability and structured logging (clean component/operation logs).
  - AP-026: Public API contracts & DTO boundaries (`ExtensionAPI` parity: `setActiveTools`, `getActiveTools`, `before_agent_start`).
  - AP-028: Testing determinism & honest assertions (ban shallow mocks, verify true Harness state).
  - AP-032: Command/Query Separation (querying tools does not mutate state; changing tools is an explicit configure command).
- **Active paths:**
  - `src/runner/tool-adapter.ts`
  - `src/runner/prompt.ts`
  - `src/runner/extension-bridge.ts`
  - `src/runner/extension-mount.ts`
  - `src/runner/runtime-controller.ts`
  - `src/runner/runtime.ts`
  - `src/runner/runtime-loader.ts`
  - `src/runner/index.ts`
- **Verification surface:**
  - `npm test` (targeted and full suite 580 backend + 117 UI = 697 tests)
  - `npm run test:contracts`
  - `npx tsc --noEmit`
  - `npm run build`

---

## Detailed Canonical Analysis of Subsystem Contracts

### 1. Codemode Canonical Contract in Pi Durable
In `@earendil-works/pi-durable/codemode`:
- The `codemode` tool executes JavaScript inside a QuickJS sandbox.
- When a script runs `await tools.<name>(args)`, `CodemodeCall.executeTool` resolves the tool in `agent.callable`, NOT `agent.tools`.
- `agent.callable` is computed in `packages/durable/src/harness/agent.ts:266`:
  ```ts
  const callable = enabled.filter(callableBy("tools"));
  ```
  `enabled` is filtered by `state.tools` (which enables/disables tools globally). `state.modelTools` ONLY filters `tools` (what is offered to the model directly).
- Therefore:
  * When `tool-diet` sets `setActiveTools(["codemode"])`, `state.modelTools` becomes `["codemode"]`.
  * The LLM receives ONLY `codemode` in its tool declarations schema, cutting ~55k tokens of schema descriptions.
  * BUT all registered tools (e.g. `read`, `write`, `bash`, `mcp__*`) remain in `agent.callable`.
  * The script inside `codemode` can execute `await tools.read(...)` or `await tools.mcp__gbrain__query(...)` with zero hindrance.
  * Discovery globals (`searchTools()`, `describeTool()`, `describeNamespace()`) continue to search and return declarations from `agent.callable`.

### 2. Elimination of Silent Fallbacks in `prompt.ts`
- **Current Bad Pattern:**
  `const snippet = def?.promptSnippet ?? t.promptSnippet ?? t.description ?? "";`
  `return snippet ? `- ${t.name}: ${snippet}` : `- ${t.name}`;`
  If a tool had no snippet, it dumped the full `description` (often 50–100 lines) into system prompt text. If `description` was also missing, it emitted a bare bullet `- ${t.name}`.
- **Upstream Canonical Pi Contract (`packages/coding-agent/src/core/system-prompt.ts:137–142`):**
  `// Tools without a snippet are not listed.`
  ```ts
  const visibleTools = declaredTools.filter((name) => !!toolSnippets[name]);
  const tools = visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets[name]}`).join("\n") : "(none)";
  promptSections.tools = `${tools}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.`;
  ```
- **The Rule:** Only tools that supply a `promptSnippet` are listed in the `<tools>` summary text block. Tools without snippets are omitted from the text block because the model already receives their complete parameters and descriptions in the API request's `tools` JSON schema parameter. No character-clipping, no description fallback, no bare bullets.

### 3. Elimination of Empty Catch Blocks (AP-012, AP-022)
In `src/runner/index.ts:48–59`:
```ts
// BEFORE (VIOLATES AP-022):
try { activeControlChannel?.close(); } catch {}
try { activeGraphSource?.teardown(); } catch {}
try { await flushWireStdout(); } catch {}

// AFTER (COMPLIANT):
try { activeControlChannel?.close(); } catch (err) {
    console.warn(`[Runner] Error closing control channel on ${signalOrReason}: ${err instanceof Error ? err.message : String(err)}`);
}
try { activeGraphSource?.teardown(); } catch (err) {
    console.warn(`[Runner] Error tearing down graph source on ${signalOrReason}: ${err instanceof Error ? err.message : String(err)}`);
}
try { await flushWireStdout(); } catch (err) {
    console.warn(`[Runner] Error flushing stdout on ${signalOrReason}: ${err instanceof Error ? err.message : String(err)}`);
}
```

---

## Tasks

### Task 1: Canonical Tool Metadata Preservation & Fallback Elimination (AP-026, AP-012, AP-019)

**Files:**
- Modify: `src/runner/tool-adapter.ts` (current: 172 LOC, budget: < 200 LOC)
- Modify: `src/runner/prompt.ts` (current: 182 LOC, budget: < 200 LOC)
- Test: `tests/prompt-adapter.test.ts`

- [ ] **Step 1.1: Write failing test in `tests/prompt-adapter.test.ts`**
  Add unit tests verifying:
  1. `adaptExtensionTool` forwards `promptSnippet` and `promptGuidelines` from `ToolDefinition` to `ToolRegistration`.
  2. Tools with `promptSnippet` render as `- ${name}: ${snippet}` in `sections.tools`.
  3. Tools WITHOUT `promptSnippet` are strictly OMITTED from `sections.tools` text, never dumping `description` or bare bullets.
  4. Guidelines from `promptGuidelines` are included in `sections.rules`.
  Run: `node --test tests/prompt-adapter.test.ts` (must fail).

- [ ] **Step 1.2: Implement metadata forwarding in `src/runner/tool-adapter.ts`**
  In `adaptExtensionTool`:
  Forward `promptSnippet: toolDef.promptSnippet` and `promptGuidelines: toolDef.promptGuidelines` into the object passed to `defineTool(...)`.

- [ ] **Step 1.3: Align `src/runner/prompt.ts` with Canonical Upstream Pi**
  In `buildSections`:
  Replace the fallback `?? t.description ?? ""` and bare bullet logic with:
  ```ts
  const visibleTools = tools.flatMap((t) => {
      const def = CANONICAL_TOOL_DEFS[t.name as keyof typeof CANONICAL_TOOL_DEFS];
      const snippet = def?.promptSnippet ?? t.promptSnippet;
      return snippet ? [`- ${t.name}: ${snippet}`] : [];
  });
  const toolsText = visibleTools.length > 0 ? visibleTools.join("\n") : "(none)";
  sections.tools = `<tools>\n${toolsText}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.\n</tools>`;
  ```
  Ensure rules continue to build from `buildRules(tools)`.

- [ ] **Step 1.4: Verify tests and line budget**
  Run: `node --test tests/prompt-adapter.test.ts` (must pass).
  Check LOC: `wc -l src/runner/tool-adapter.ts src/runner/prompt.ts` (both strictly < 200 LOC).

---

### Task 2: Active Tools Notification & Extension Bridge Sync (AP-020, AP-026, AP-019)

**Files:**
- Modify: `src/runner/extension-bridge.ts` (current: 191 LOC, budget: < 200 LOC)
- Modify: `src/runner/extension-mount.ts` (current: 182 LOC, budget: < 200 LOC)
- Test: `tests/extension-bridge.test.ts`

- [ ] **Step 2.1: Write failing test in `tests/extension-bridge.test.ts`**
  Verify that:
  1. `setupExtensionRunner` accepts `onActiveToolsChanged: (tools: string[]) => void`.
  2. Calling `runner.runtime.setActiveTools(["read", "write"])` notifies `onActiveToolsChanged` with `["read", "write"]`.
  3. Calling `runner.runtime.refreshTools()` triggers `onToolsChanged`.
  Run: `node --test tests/extension-bridge.test.ts` (must fail).

- [ ] **Step 2.2: Implement `onActiveToolsChanged` in `src/runner/extension-bridge.ts`**
  Add `onActiveToolsChanged?: (tools: string[]) => void` to `SetupExtensionRunnerOptions`.
  In `actions.setActiveTools(toolNames: string[])`:
  ```ts
  setActiveTools: (toolNames: string[]) => {
      activeToolNames = [...toolNames];
      options.onActiveToolsChanged?.(activeToolNames);
  },
  ```
  Keep file compact to stay strictly under 200 LOC.

- [ ] **Step 2.3: Correct Mount Sequence & Action Delegation in `src/runner/extension-mount.ts`**
  In `mountExtensionBridge`:
  1. Call `syncToolsToRegistry()` BEFORE `emitBeforeAgentStart`, ensuring extension tools exist in the registry snapshot before the initial hook runs.
  2. In `actionsDelegate`: add `onConfigureModelTools?: (tools: string[]) => Promise<void> | void`.
  3. Wire `onActiveToolsChanged`: call `actionsDelegate?.onConfigureModelTools?.(tools)`.

- [ ] **Step 2.4: Verify tests and line budget**
  Run: `node --test tests/extension-bridge.test.ts` (must pass).
  Check LOC: `wc -l src/runner/extension-bridge.ts src/runner/extension-mount.ts` (both strictly < 200 LOC).

---

### Task 3: Dual-Channel Hook Reconciliation in Runtime Controller (AP-010, AP-020, AP-032, AP-019)

**Files:**
- Modify: `src/runner/runtime-controller.ts` (current: 178 LOC, budget: < 200 LOC)
- Modify: `src/runner/runtime-types.ts`
- Create: `tests/active-tool-loadout.test.ts`

- [ ] **Step 3.1: Write failing test in `tests/active-tool-loadout.test.ts`**
  Write tests covering:
  1. `submit()` reads current active tools from `bindings.current.agent()` and passes them in `emitBeforeAgentStart`.
  2. When an extension hook directly modifies `systemPromptOptions.selectedTools`, controller executes `bindings.current.configure({ modelTools: selectedTools })`.
  3. When an extension hook does not touch `selectedTools` but calls `pi.setActiveTools()`, the `setActiveTools` list is applied to `bindings.current.configure({ modelTools })`.
  4. Dynamic sections are updated from `systemPromptOptions.sections`.
  5. Any configuration failure throws or logs a structured notice via `ctx.notice("warning", ...)`.
  Run: `node --test tests/active-tool-loadout.test.ts` (must fail).

- [ ] **Step 3.2: Implement dual-channel reconciliation in `src/runner/runtime-controller.ts`**
  In `submit`:
  ```ts
  if (ctx.extensionRunner) {
      try {
          const currentAgent = await ctx.bindings.current.agent(runtimeContext);
          const activeTools = currentAgent.tools.map((t) => t.name);
          const hookRes = await ctx.extensionRunner.emitBeforeAgentStart(
              { messageType: "user", prompt, images: images?.length ? images : undefined },
              {
                  cwd: ctx.cwd ?? process.cwd(),
                  selectedTools: activeTools,
                  sections: ctx.dynamicSections?.getSections() ?? {},
              } as import("@earendil-works/pi-coding-agent").BuildSystemPromptOptions,
          );
          if (hookRes?.systemPromptOptions?.sections && ctx.dynamicSections) {
              ctx.dynamicSections.updateSections(hookRes.systemPromptOptions.sections);
          }
          const selectedTools = hookRes?.systemPromptOptions?.selectedTools;
          const handlerEdited = selectedTools && (
              selectedTools.length !== activeTools.length ||
              selectedTools.some((name, i) => name !== activeTools[i])
          );
          const nextActiveTools = handlerEdited ? selectedTools : ctx.getActiveTools?.();
          if (nextActiveTools && (nextActiveTools.length !== activeTools.length || nextActiveTools.some((name, i) => name !== activeTools[i]))) {
              await ctx.bindings.current.configure({ modelTools: nextActiveTools }, runtimeContext);
          }
      } catch (err) {
          ctx.notice("warning", `before_agent_start error: ${err instanceof Error ? err.message : String(err)}`);
      }
  }
  ```

- [ ] **Step 3.3: Verify tests and line budget**
  Run: `node --test tests/active-tool-loadout.test.ts` (must pass).
  Check LOC: `wc -l src/runner/runtime-controller.ts` (strictly < 200 LOC).

---

### Task 4: Startup & Reopen/Resume Hydration (AP-010, AP-012, AP-030, AP-019)

**Files:**
- Modify: `src/runner/runtime.ts` (current: 182 LOC, budget: < 200 LOC)
- Modify: `src/runner/runtime-loader.ts`
- Test: `tests/active-tool-loadout.test.ts`

- [ ] **Step 4.1: Write failing test for session reopen persistence**
  In `tests/active-tool-loadout.test.ts`:
  1. Open a new session, configure active tools to `["read", "edit"]`.
  2. Verify `rootAgent.tools` contains only `read` and `edit`.
  3. Close session and reopen it with `continueSession: true`.
  4. Verify reopened session has `rootAgent.tools` equal to `["read", "edit"]` and `runner.getActiveTools()` returns `["read", "edit"]`.
  Run: `node --test tests/active-tool-loadout.test.ts` (must fail).

- [ ] **Step 4.2: Implement startup and reopen hydration in `src/runner/runtime.ts`**
  In `openDurable`:
  - When `location.created === true`: pass initial active tools (if set by extensions during startup) as `modelTools` to `harness.root({ agent: { modelTools: ... } })`.
  - When `location.created === false`: after `const rootAgent = await root.agent(runtimeContext)`, read `rootAgent.tools.map((t) => t.name)`. If tools are filtered, hydrate `activeEnvState.extensionRunner` active tools.
  - Wire `actionsDelegate.onConfigureModelTools` to `async (tools) => { await root.configure({ modelTools: tools }, runtimeContext); }`.

- [ ] **Step 4.3: Verify tests and line budget**
  Run: `node --test tests/active-tool-loadout.test.ts` (must pass).
  Check LOC: `wc -l src/runner/runtime.ts src/runner/runtime-loader.ts` (strictly < 200 LOC).

---

### Task 5: Deep Codemode & Subagent Boundary Verification (AP-011, AP-026, AP-028)

**Files:**
- Modify: `tests/codemode-mcp-parity.test.ts`
- Create: `tests/active-tool-loadout-codemode.test.ts`
- Test: `tests/codemode-*.test.ts`, `tests/subagent-*.test.ts`

- [ ] **Step 5.1: Cleanse false-positive assertion in `tests/codemode-mcp-parity.test.ts`**
  Remove the shallow `assert.deepEqual(runner.getActiveTools(), ["a", "b"])` check that lacked harness verification. Replace with verification that `setActiveTools` triggers `onActiveToolsChanged`.

- [ ] **Step 5.2: Write Codemode & Subagent isolation tests in `tests/active-tool-loadout-codemode.test.ts`**
  Add deep tests covering:
  1. **Codemode execution under tool-diet:** Configure `modelTools` to `["codemode"]`. Verify:
     - `agent.tools` contains ONLY `codemode`.
     - `agent.callable` contains all registered tools (e.g. `read`, `bash`, `mcp__*`).
     - Codemode script `await tools.read({ path: "..." })` executes successfully via `agent.callable`.
  2. **Codemode discovery globals under tool-diet:** Inside Codemode script, `searchTools("read")` returns `read` tool declaration from `agent.callable`.
  3. **Codemode tool failure propagation:** When a tool called from Codemode throws, verify that `isError: true` propagates and throws an Error inside the sandbox without swallowed exceptions.
  4. **Subagent conversation isolation:** Creating a subagent (`subagent.ts`) executes under its own conversation without corrupting or leaking into the parent's `modelTools`.

- [ ] **Step 5.3: Run all Codemode and Subagent tests**
  Run: `node --test tests/codemode-*.test.ts tests/subagent-*.test.ts tests/active-tool-loadout-codemode.test.ts` (all must pass).

---

### Task 6: Teardown Error Handling & Empty Catch Remediation (AP-012, AP-022, AP-024)

**Files:**
- Modify: `src/runner/index.ts`
- Test: `tests/worker-teardown.test.ts`

- [ ] **Step 6.1: Replace empty catch blocks in `src/runner/index.ts`**
  In `handleExit`:
  Replace empty `catch {}` on control channel, graph source, and stdout flush with structured warnings:
  ```ts
  try { activeControlChannel?.close(); } catch (err) {
      console.warn(`[Runner] Error closing control channel on ${signalOrReason}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try { activeGraphSource?.teardown(); } catch (err) {
      console.warn(`[Runner] Error tearing down graph source on ${signalOrReason}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try { await flushWireStdout(); } catch (err) {
      console.warn(`[Runner] Error flushing wire stdout on ${signalOrReason}: ${err instanceof Error ? err.message : String(err)}`);
  }
  ```

- [ ] **Step 6.2: Verify teardown tests**
  Run: `node --test tests/worker-teardown.test.ts` (must pass).

---

### Task 7: Dual-Circuit Verification & Ledger Update (AP-019, AP-028)

**Files:**
- Modify: `docs/arch-improvement/ledger.md`
- Modify: `docs/arch-improvement/memory.md`

- [ ] **Step 7.1: Run full verification suite**
  Run:
  ```sh
  npm run test:contracts
  npx tsc --noEmit
  npm test
  node scripts/verify-import-graph.mjs
  npm run build
  ```
  All commands must pass with 0 errors, 0 failed tests (697+ pass).

- [ ] **Step 7.2: Check line budgets (AP-019)**
  Verify all modified files are strictly below line limits:
  `wc -l src/runner/tool-adapter.ts src/runner/prompt.ts src/runner/extension-bridge.ts src/runner/extension-mount.ts src/runner/runtime-controller.ts src/runner/runtime.ts src/runner/index.ts` (all strictly < 200/250 LOC).

- [ ] **Step 7.3: Append Cycle 98 to `docs/arch-improvement/ledger.md`**
  Record Cycle 98 with goal, root causes resolved, TDD evidence, test results, line budgets, and build receipt.

- [ ] **Step 7.4: Append lesson to `docs/arch-improvement/memory.md`**
  Record lesson on `AgentDoc.modelTools` vs `AgentDoc.tools` vs `agent.callable` and the strict ban on prompt description fallbacks and empty catches.
