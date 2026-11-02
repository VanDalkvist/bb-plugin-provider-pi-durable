# BB Dynamic Tools & Interaction Bridge (Cycle 104) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement full bidirectional support for Beyond Boundaries dynamic agent tools (`dynamicTools`, `item/tool/call`), policy filtering (`disallowedTools`), and interactive UI dialogs (`interaction/request`) in `bb-plugin-provider-pi-durable`, achieving 100% parity with BB 0.48.1 while strictly preserving the sovereignty of the `@durable-zero` core (0 leaks of BB abstractions).

**Architecture:** 
1. In the host worker (`src/host/`), parse `params.dynamicTools` and `params.disallowedTools` from BB JSON-RPC calls (`thread/start`, `thread/resume`). Filter out disallowed tools and persist tool declarations to a temporary session tools file `pi-tools-<sessionKey>.json`.
2. Implement a thread-safe `PendingToolCallTracker` in `src/host/tool-call-tracker.ts` handling `item/tool/call` bidirectional RPC forwarding and response matching with cancellation and teardown cleanup.
3. In the runner (`src/runner/`), create a synthetic native Pi extension (`src/runner/extensions/bb-tools-extension.ts`) that reads `dynamicTools`, converts JSON Schema to TypeBox, and exposes them through `ExtensionRunner`. Existing `syncToolsToRegistry` automatically mounts them into the Durable `Registry`, registers them in `dynamicNamespaces` for `codemode`, and exposes them to `tool_search`.
4. In `src/shared/extension-ui-context.ts`, wire `select`, `confirm`, `input`, and `editor` to send `extension_ui_request` via control channel (`stdio[4]`), which the host worker forwards to BB as `interaction/request`.

**Tech Stack:** TypeScript, Node.js 22, `@earendil-works/pi-durable`, `@earendil-works/pi-coding-agent`, `@sinclair/typebox`, Zod, node:test.

**Architecture Rules (AP gates):**
- **AP-010:** Boundary isolation & Single Responsibility.
- **AP-011:** Strict typing, 0 `any` leaks.
- **AP-012:** Explicit domain error codes (`TOOL_CALL_FAILED`, `INTERACTION_CANCELLED`).
- **AP-013:** Fail-closed verification and timeouts.
- **AP-014:** Resource lifecycle and clean teardown on abort/stop.
- **AP-019:** Line budget < 250 LOC per file in `src/`.
- **AP-026:** Strict dependencies and layers.
- **AP-028:** Dependency Inversion (Ports & Adapters).
- **AP-073:** Separation of Declaration from Configuration and Use.

---

### Slice 1: Contract Schemas for Dynamic Tools & BB Bridge Protocol

- **Boundary:** `src/contracts/bb-tools.ts`
- **AP gates:** AP-010, AP-011, AP-019, AP-026
- **Red test first:** `tests/contracts-bb-tools.test.ts` fails because schemas do not exist.
- **Implementation:** Declare Zod schemas for `BbDynamicToolDefinition`, `BbToolCallParams`, `BbToolCallResult`, and `BbInteractionPayload`.

- [ ] **Step 1: Write the failing test**

File: `/Users/vanya/Projects/bb-plugin-provider-pi-durable/tests/contracts-bb-tools.test.ts`
```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
	bbDynamicToolSchema,
	bbToolCallRequestParamsSchema,
	bbToolCallResponseSchema,
	bbInteractionRequestParamsSchema,
} from "../src/contracts/bb-tools.ts";

test("bbDynamicToolSchema validates valid BB dynamic tool definition", () => {
	const valid = {
		name: "check_ui",
		description: "Checks a ```ui block before putting it in reply",
		inputSchema: {
			type: "object",
			properties: { spec: { type: "string" } },
			required: ["spec"],
		},
		presentation: { label: { pending: "Checking UI", completed: "Checked UI" }, suppress: true },
	};
	const parsed = bbDynamicToolSchema.safeParse(valid);
	assert.equal(parsed.success, true);
	if (parsed.success) {
		assert.equal(parsed.data.name, "check_ui");
	}
});

test("bbToolCallRequestParamsSchema parses item/tool/call params", () => {
	const payload = {
		threadId: "thr_123",
		providerThreadId: "pi_durable_179348",
		turnId: null,
		callId: "call-1",
		tool: "check_ui",
		arguments: { spec: "Card('Title', [])" },
	};
	const parsed = bbToolCallRequestParamsSchema.safeParse(payload);
	assert.equal(parsed.success, true);
});

test("bbToolCallResponseSchema extracts text content items and error flags", () => {
	const okRes = {
		contentItems: [{ type: "inputText", text: "No errors." }],
	};
	const parsed = bbToolCallResponseSchema.safeParse(okRes);
	assert.equal(parsed.success, true);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `node --import tsx --test tests/contracts-bb-tools.test.ts`
Expected: FAIL with `Cannot find module '../src/contracts/bb-tools.ts'`

- [ ] **Step 3: Implement `src/contracts/bb-tools.ts`**

File: `/Users/vanya/Projects/bb-plugin-provider-pi-durable/src/contracts/bb-tools.ts`
```ts
import { z } from "zod";

export const bbDynamicToolSchema = z.object({
	name: z.string().min(1),
	description: z.string().default(""),
	inputSchema: z.unknown().default({}),
	presentation: z.object({
		label: z.object({
			pending: z.string().optional(),
			completed: z.string().optional(),
		}).optional(),
		icon: z.object({ glyph: z.string().optional() }).optional(),
		suppress: z.boolean().optional(),
	}).optional(),
}).passthrough();

export type BbDynamicTool = z.infer<typeof bbDynamicToolSchema>;

export const bbToolCallRequestParamsSchema = z.object({
	threadId: z.string().min(1).optional(),
	providerThreadId: z.string().min(1),
	turnId: z.union([z.string().min(1), z.null()]).default(null),
	callId: z.string().min(1),
	tool: z.string().min(1),
	arguments: z.unknown().default({}),
});

export type BbToolCallRequestParams = z.infer<typeof bbToolCallRequestParamsSchema>;

export const bbContentItemSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("inputText"), text: z.string() }),
	z.object({ type: z.literal("inputImage"), imageUrl: z.string() }),
]);

export const bbToolCallResponseSchema = z.object({
	contentItems: z.array(bbContentItemSchema).default([]),
	isError: z.boolean().optional(),
	error: z.object({ message: z.string().optional() }).optional(),
}).passthrough();

export type BbToolCallResponse = z.infer<typeof bbToolCallResponseSchema>;

export const bbInteractionRequestParamsSchema = z.object({
	threadId: z.string().min(1).optional(),
	providerThreadId: z.string().min(1),
	turnId: z.union([z.string().min(1), z.null()]).default(null),
	payload: z.object({
		kind: z.enum(["select", "confirm", "input", "editor", "notify"]),
		title: z.string().optional(),
		message: z.string().optional(),
		data: z.unknown().optional(),
	}),
});

export type BbInteractionRequestParams = z.infer<typeof bbInteractionRequestParamsSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/contracts-bb-tools.test.ts`
Expected: PASS (3/3 tests)

- [ ] **Step 5: Commit Slice 1**

```bash
git add src/contracts/bb-tools.ts tests/contracts-bb-tools.test.ts
git commit -m "feat(contracts): add BB dynamic tools and interaction bridge schemas"
```

---

### Slice 2: Host Dynamic Tools Persistence & Policy Filtering

- **Boundary:** `src/host/session-options.ts`, `src/host/types.ts`
- **AP gates:** AP-010, AP-012, AP-019 (<250 LOC)
- **Red test first:** `tests/host-session-options-dynamic-tools.test.ts` fails because `dynamicTools` and `disallowedTools` are not captured or serialized.
- **Implementation:** Accept `dynamicTools` and `disallowedTools` in `buildSessionOptions()`. Filter out disallowed tools, write tools to `pi-tools-<sessionKey>.json` in `scratchDir`, and attach `toolsFilePath` to `SessionOptions`.

- [ ] **Step 1: Write the failing test**

File: `/Users/vanya/Projects/bb-plugin-provider-pi-durable/tests/host-session-options-dynamic-tools.test.ts`
```ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildSessionOptions } from "../src/host/session-options.ts";

test("buildSessionOptions serializes dynamic tools and filters disallowed tools", () => {
	const params = {
		cwd: "/test/cwd",
		dynamicTools: [
			{ name: "check_ui", description: "check ui", inputSchema: {} },
			{ name: "disallowed_tool", description: "blocked", inputSchema: {} },
		],
		disallowedTools: ["disallowed_tool"],
	};

	const opts = buildSessionOptions("thr_1", "pi_thread_1", "pi_thread_1", params as any, []);
	assert.ok(opts.toolsFilePath, "toolsFilePath must be populated");
	assert.ok(fs.existsSync(opts.toolsFilePath), "tools file must be written to disk");

	const content = JSON.parse(fs.readFileSync(opts.toolsFilePath, "utf8"));
	assert.equal(content.length, 1);
	assert.equal(content[0].name, "check_ui");

	// Clean up
	fs.unlinkSync(opts.toolsFilePath);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `node --import tsx --test tests/host-session-options-dynamic-tools.test.ts`
Expected: FAIL with `toolsFilePath must be populated`

- [ ] **Step 3: Update `src/host/types.ts` and `src/host/session-options.ts`**

Update `SessionOptions` interface in `src/host/types.ts` with optional `toolsFilePath?: string`.
In `src/host/session-options.ts`, process `dynamicTools` and `disallowedTools`, write JSON file to `scratchDir`, and return `toolsFilePath`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/host-session-options-dynamic-tools.test.ts`
Expected: PASS

- [ ] **Step 5: Commit Slice 2**

```bash
git add src/host/session-options.ts src/host/types.ts tests/host-session-options-dynamic-tools.test.ts
git commit -m "feat(host): persist BB dynamic tools and enforce disallowed tools filtering"
```

---

### Slice 3: Bidirectional `item/tool/call` RPC Tracker in Host Bridge

- **Boundary:** `src/host/tool-call-tracker.ts`, `src/host/bridge.ts`
- **AP gates:** AP-010, AP-012, AP-014, AP-028
- **Red test first:** `tests/host-tool-call-tracker.test.ts` fails because `PendingToolCallTracker` does not exist.
- **Implementation:** Create `PendingToolCallTracker` managing pending tool calls with monotonic IDs, timeouts, and teardown cleanup. Wire it into `ProviderBridge.handleLine()` to resolve JSON-RPC replies.

- [ ] **Step 1: Write the failing test**

File: `/Users/vanya/Projects/bb-plugin-provider-pi-durable/tests/host-tool-call-tracker.test.ts`
```ts
import test from "node:test";
import assert from "node:assert/strict";
import { PendingToolCallTracker } from "../src/host/tool-call-tracker.ts";

test("PendingToolCallTracker sends item/tool/call and resolves on reply", async () => {
	const sentMessages: any[] = [];
	const tracker = new PendingToolCallTracker((msg) => sentMessages.push(msg));

	const callPromise = tracker.forwardToolCall({
		threadId: "thr_1",
		providerThreadId: "pi_1",
		toolName: "check_ui",
		arguments: { spec: "Card('Test', [])" },
		scope: "session_1",
	});

	assert.equal(sentMessages.length, 1);
	assert.equal(sentMessages[0].method, "item/tool/call");
	assert.equal(sentMessages[0].params.tool, "check_ui");

	const reqId = sentMessages[0].id;
	const handled = tracker.handleToolCallResponse({
		jsonrpc: "2.0",
		id: reqId,
		result: {
			contentItems: [{ type: "inputText", text: "No errors." }],
		},
	});
	assert.equal(handled, true);

	const res = await callPromise;
	assert.equal(res.isError, false);
	assert.deepEqual(res.content, [{ type: "text", text: "No errors." }]);
});

test("PendingToolCallTracker handles error response and scope cancellation", async () => {
	const tracker = new PendingToolCallTracker(() => {});
	const callPromise = tracker.forwardToolCall({
		threadId: "thr_1",
		providerThreadId: "pi_1",
		toolName: "broken_tool",
		arguments: {},
		scope: "session_2",
	});

	tracker.resolvePendingToolCalls("session_2", "Session aborted");
	const res = await callPromise;
	assert.equal(res.isError, true);
	assert.ok(res.content[0].text.includes("Session aborted"));
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `node --import tsx --test tests/host-tool-call-tracker.test.ts`
Expected: FAIL with `Cannot find module '../src/host/tool-call-tracker.ts'`

- [ ] **Step 3: Implement `src/host/tool-call-tracker.ts` and integrate in `src/host/bridge.ts`**

File: `/Users/vanya/Projects/bb-plugin-provider-pi-durable/src/host/tool-call-tracker.ts`
Implement `PendingToolCallTracker` (< 120 LOC).
Wire into `ProviderBridge` in `src/host/bridge.ts` to intercept responses for `id` tracked by `toolCallTracker`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/host-tool-call-tracker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit Slice 3**

```bash
git add src/host/tool-call-tracker.ts src/host/bridge.ts tests/host-tool-call-tracker.test.ts
git commit -m "feat(host): add PendingToolCallTracker for item/tool/call RPC bridging"
```

---

### Slice 4: Runner BB Dynamic Tools Extension & Durable Registry Mounting

- **Boundary:** `src/runner/extensions/bb-tools-extension.ts`, `src/runner/extension-mount.ts`
- **AP gates:** AP-010, AP-026, AP-028, AP-073
- **Red test first:** `tests/runner-bb-tools-extension.test.ts` fails because `createBbDynamicToolsExtension` does not exist.
- **Implementation:** Create `createBbDynamicToolsExtension(options)` which reads `toolsFilePath`, parses `BbDynamicTool[]`, converts JSON Schemas to TypeBox schemas, and exposes tools that delegate to `forwardToolCall`. Pass this extension into `setupExtensionRunner`.

- [ ] **Step 1: Write the failing test**

File: `/Users/vanya/Projects/bb-plugin-provider-pi-durable/tests/runner-bb-tools-extension.test.ts`
```ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBbDynamicToolsExtension } from "../src/runner/extensions/bb-tools-extension.ts";

test("createBbDynamicToolsExtension registers tools from toolsFilePath", async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-tools-test-"));
	const toolsFile = path.join(tempDir, "tools.json");
	fs.writeFileSync(toolsFile, JSON.stringify([
		{
			name: "check_ui",
			description: "Checks a ```ui block",
			inputSchema: {
				type: "object",
				properties: { spec: { type: "string" } },
				required: ["spec"],
			},
		},
	]), "utf8");

	let forwardedName = "";
	let forwardedArgs: any = null;
	const ext = createBbDynamicToolsExtension({
		toolsFilePath: toolsFile,
		forwardToolCall: async (name, args) => {
			forwardedName = name;
			forwardedArgs = args;
			return { content: [{ type: "text", text: "OK" }], isError: false };
		},
	});

	assert.ok(ext.tools.has("check_ui"), "check_ui must be registered in extension tools Map");
	const tool = ext.tools.get("check_ui")!;
	assert.equal(tool.name, "check_ui");

	const res = await tool.execute("call_1", { spec: "Card('Title', [])" } as any, undefined as any);
	assert.equal(forwardedName, "check_ui");
	assert.deepEqual(forwardedArgs, { spec: "Card('Title', [])" });
	assert.equal((res as any).content[0].text, "OK");

	fs.rmSync(tempDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `node --import tsx --test tests/runner-bb-tools-extension.test.ts`
Expected: FAIL with `Cannot find module '../src/runner/extensions/bb-tools-extension.ts'`

- [ ] **Step 3: Implement `src/runner/extensions/bb-tools-extension.ts` and wire into `extension-mount.ts`**

File: `/Users/vanya/Projects/bb-plugin-provider-pi-durable/src/runner/extensions/bb-tools-extension.ts` (< 150 LOC).
Convert `inputSchema` to TypeBox via canonical schema mapper.
Mount in `src/runner/extension-mount.ts` as part of `extensionsResult.extensions`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/runner-bb-tools-extension.test.ts`
Expected: PASS

- [ ] **Step 5: Commit Slice 4**

```bash
git add src/runner/extensions/bb-tools-extension.ts src/runner/extension-mount.ts tests/runner-bb-tools-extension.test.ts
git commit -m "feat(runner): implement bb-tools-extension for dynamic BB tools mounting"
```

---

### Slice 5: Interactive UI Dialogs (`interaction/request`)

- **Boundary:** `src/shared/extension-ui-context.ts`, `src/host/interaction-tracker.ts`, `src/host/bridge.ts`
- **AP gates:** AP-010, AP-012, AP-014
- **Red test first:** `tests/extension-ui-interaction.test.ts` fails because UI dialogs return default stubs instead of querying BB.
- **Implementation:** Wire `createExtensionUIContext` to send `extension_ui_request` through the bridge channel, forward it via `interaction/request` in the host worker, and return the user selection/confirmation.

- [ ] **Step 1: Write the failing test**

File: `/Users/vanya/Projects/bb-plugin-provider-pi-durable/tests/extension-ui-interaction.test.ts`
```ts
import test from "node:test";
import assert from "node:assert/strict";
import { PendingInteractionTracker } from "../src/host/interaction-tracker.ts";

test("PendingInteractionTracker formats interaction/request and resolves on reply", async () => {
	const sent: any[] = [];
	const tracker = new PendingInteractionTracker((msg) => sent.push(msg));

	const interactionPromise = tracker.requestInteraction({
		threadId: "thr_1",
		providerThreadId: "pi_1",
		kind: "confirm",
		title: "Delete file?",
		message: "Are you sure?",
		scope: "session_1",
	});

	assert.equal(sent.length, 1);
	assert.equal(sent[0].method, "interaction/request");
	assert.equal(sent[0].params.payload.kind, "confirm");

	const reqId = sent[0].id;
	tracker.handleInteractionResponse({
		jsonrpc: "2.0",
		id: reqId,
		result: { confirmed: true },
	});

	const result = await interactionPromise;
	assert.deepEqual(result, { confirmed: true });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `node --import tsx --test tests/extension-ui-interaction.test.ts`
Expected: FAIL with `Cannot find module '../src/host/interaction-tracker.ts'`

- [ ] **Step 3: Implement `src/host/interaction-tracker.ts` and update `src/shared/extension-ui-context.ts`**

Implement `PendingInteractionTracker` (< 110 LOC).
Wire `extension_ui_request` handling across `RunnerProcess` and `ProviderBridge`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/extension-ui-interaction.test.ts`
Expected: PASS

- [ ] **Step 5: Commit Slice 5**

```bash
git add src/host/interaction-tracker.ts src/shared/extension-ui-context.ts src/host/bridge.ts tests/extension-ui-interaction.test.ts
git commit -m "feat(ui): implement interaction/request bridge for native BB dialogs"
```

---

### Slice 6: Full Verification, Line Budgets, Acyclicity & Doctor

- **Boundary:** End-to-End System Integration & Architecture Verification
- **AP gates:** AP-019 (<250 LOC per file in `src/`), AP-026, AP-013, AP-030
- **Red test first:** Run full test suite and verify 0 regressions.
- **Verification Commands:**
  - `npm test` (Target: 755+ pass, 0 fail)
  - `npm run test:contracts` (0 TS errors)
  - `node scripts/verify-import-graph.mjs` (0 cycles)
  - `node scripts/verify-layer-boundaries.mjs` (0 boundary violations)
  - `npm run doctor` (HEALTHY)
  - `git diff --stat` (all files < 250 LOC)

- [ ] **Step 1: Run comprehensive test suite**

Run: `cd /Users/vanya/Projects/bb-plugin-provider-pi-durable && npm test`
Expected: PASS with 760+ passing tests

- [ ] **Step 2: Run contract and architecture verifiers**

Run: `npm run test:contracts && node scripts/verify-import-graph.mjs && node scripts/verify-layer-boundaries.mjs`
Expected: All 3 pass cleanly

- [ ] **Step 3: Verify Line Budgets (AP-019)**

Run: `find src -name "*.ts" | xargs wc -l | sort -n`
Expected: All files strictly < 250 LOC

- [ ] **Step 4: Update ledger and memory**

Record Cycle 104 in `docs/arch-improvement/ledger.md` and verify with GBrain.

- [ ] **Step 5: Commit and release**

```bash
git add .
git commit -m "feat(arch): complete Cycle 104 BB dynamic tools and interaction bridge"
git push origin main
```
