# Arch Improvement Cycle 99 — Sovereign Hexagonal Kernel & Extension Parity (v0.4.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the Pi Durable agent harness (`src/runner`) into an autonomous, sovereign computing hexagon by eliminating all Beyond Boundaries host leaks (raw SQLite access, client `threadId` storage, out-of-band FD 3/4 readiness, BB Core title limits) and achieving first-class parity for external Pi extensions (`sendUserMessage` submission to Durable FSM, multi-path `--extension`, and `--no-global-extensions` isolation).

**Architecture:** The Pi Durable engine becomes an autonomous computing kernel running `@earendil-works/pi-durable` 1.4 with transactional SQLite WAL storage. Core capabilities are structured as single-responsibility plugins mounted via `DurablePluginRegistry`. Inbound communication uses standard POSIX stdio (stdin/stdout JSONL) with out-of-band FD 3/4 as an optional transport. Host presentation artifacts (`PlanStep`, client `threadId` mappings) are pushed completely into `src/host/`.

**Tech Stack:** TypeScript 5.7, Node.js 24 (`node:sqlite`, `node:child_process`), `@earendil-works/pi-durable` 1.4, `@earendil-works/pi-coding-agent`, Zod 3.24, Node Test Runner.

---

## 1. Implementer Orientation & Required Reading

Before modifying any file, the implementing engineer **MUST** read:
1. `docs/arch-improvement/cycle-99-decoupling-audit.md` (The 4 P1 and 3 P2 architectural defects from the independent audit).
2. `docs/arch-improvement/memory.md` (Active lessons, specifically AP-010/AP-020 on Ports & Adapters, and AP-022 on silent catch blocks).
3. Thread `@thread:thr_768j569grv` (The Herdr / Delm / Andrey's taskboard extension blockers: empty `sendUserMessage`, scalar `--extension`).
4. `src/runner/extension-bridge.ts:130-142` (The empty stub `sendUserMessage: () => {}`).
5. `src/runner/cli-args.ts:30-40` (The single scalar `--extension` overwrite bug).
6. `src/host/durable-binding-store.ts:95-120` (The raw SQL `DatabaseSync` opening of `session.sqlite`).
7. `src/runner/bridge-channel.ts` and `src/runner/index.ts:170-174` (The FD 3 `ready` trap).

---

## 2. Architecture Context Map & Invariants

```markdown
Architecture Context Map
- Stage: prod (v0.4.0 Sovereign Decoupled Kernel & Extension Parity)
- Source docs: 
  - docs/arch-improvement/cycle-99-decoupling-audit.md
  - docs/arch-improvement/memory.md
  - ~/Projects/arch-rules/arch-rules.md
- Critical AP gates:
  - AP-010 (Ports & Adapters): Runner is an autonomous computing hexagon; Host is an external presentation adapter.
  - AP-011 (Low Coupling): Zero client thread concepts (threadId) inside src/runner/ domain/storage.
  - AP-012 (Fail-Fast): Invalid requests or failed submissions throw typed errors immediately; zero empty stubs.
  - AP-013 (Data Integrity): sendUserMessage reliably submits turns to Durable FSM via controller.submit().
  - AP-014 (Strategy Pattern): Dynamic extension assembly driven by DurablePluginRegistry.
  - AP-016 (Security & Boundary): Host NEVER opens runner's session.sqlite via raw SQL DatabaseSync.
  - AP-018 (Single Responsibility): Runner emits pure domain events; Host formats UI presentation cards.
  - AP-019 (Line Budgets): All modified and new .ts files strictly < 200 LOC (hard ceiling 250).
  - AP-020 (Clean Architecture): Domain logic has zero dependencies on Beyond Boundaries host infrastructure.
  - AP-021 (Transport Portability): Standard POSIX stdio (stdin/stdout) is the primary transport; FD 3/4 is strictly optional.
  - AP-028 (Deterministic Testing): 100% green tests across contract, unit, and UI suites.
```

---

## 3. Product Verification: Golden Journeys (S9b Protocol)

### Journey 1: Standalone Headless POSIX Execution (Zero FD 3/4, Pure Stdio)
- **Command:** `node dist/runner/index.js --mode rpc --session /tmp/headless_test/session.sqlite` (spawned with standard stdio `["pipe", "pipe", "pipe"]`, NO FD 3 or 4).
- **Verification:**
  - Runner process immediately emits `{"type":"ready","pid":...}` on `stdout`.
  - Process does NOT throw `ENXIO` or crash on startup.
  - Accepts domain command `{"type":"prompt","id":"1","conversationId":1,"message":"hello"}` and streams clean `RunnerEvent` frames.
  - `/tmp/headless_test/session.sqlite` contains ZERO `durable.binding` or client UI thread records.

### Journey 2: External Extension Turn Submission (`sendUserMessage` Parity)
- **Action:** Load a custom Pi extension that invokes:
  `pi.sendUserMessage("Automated task from extension", { deliverAs: "followUp" })`
- **Verification:**
  - `sendUserMessage` does NOT resolve as a blank no-op.
  - The message is reliably submitted to `durable.controller.submit(...)`.
  - The Durable FSM initiates a turn, executes tools, and commits entries into the SQLite WAL.

### Journey 3: Isolated Multi-Extension Session Spawn
- **Command:** `node dist/runner/index.js --extension ./ext1.ts --extension ./ext2.ts --no-global-extensions`
- **Verification:**
  - Both `ext1.ts` and `ext2.ts` are mounted and their tools/hooks registered.
  - Extensions from `~/.pi/agent/extensions` are NOT loaded.
  - Zero pollution in non-target workspaces.

---

## 4. File Structure & Responsibilities

| File Path | Responsibility | Boundaries & Invariants |
|---|---|---|
| `src/runner/extension-bridge.ts` | Bridge implementing Pi's `ExtensionActions` interface | Routes `sendUserMessage` and `sendMessage` to `onSubmitUserMessage`. AP-012, AP-013. |
| `src/runner/extension-mount.ts` | Mounts Pi coding-agent extensions into Durable harness | Declares `ExtensionActionsDelegate.onSubmitUserMessage`. AP-010, AP-019. |
| `src/runner/runtime.ts` | Durable FSM session runtime | Implements `actionsDelegate.onSubmitUserMessage` -> `controller.submit()`. AP-013, AP-020. |
| `src/runner/cli-args.ts` | Command-line argument parser | Parses multiple `--extension` flags into `string[]`; parses `--no-global-extensions`. AP-021. |
| `src/runner/runtime-types.ts` | Runtime configuration types | Declares `extensions?: string[]` and `noGlobalExtensions?: boolean`. AP-026. |
| `src/runner/runtime-loader.ts` | Extension and model loader | Passes `additionalExtensionPaths` array and `noExtensions: true` to `DefaultResourceLoader`. AP-010. |
| `src/runner/bridge-channel.ts` | Out-of-band IPC transport | Validates FD 3/4 before write; zero `ENXIO` in standard POSIX environments. AP-021. |
| `src/runner/index.ts` | Runner CLI entrypoint | Emits `{"type":"ready"}` to `stdout` JSONL upon readiness. AP-021. |
| `src/host/runner-process.ts` | Host process spawner | Listens for `ready` from either `stdout` JSONL or FD 3 message. AP-021. |
| `src/host/durable-binding-store.ts` | Host-side thread binding manager | Manages `threadId` <-> `conversationId` mappings in `adapter-bindings.json`; zero raw SQL on `session.sqlite`. AP-010, AP-016. |
| `src/contracts/wire-lifecycle.ts` | Engine wire lifecycle event schemas | Pure domain events (`runtime_graph_snapshot`); zero `PlanStep` or `tasks_snapshot`. AP-018, AP-026. |
| `src/runner/harness-setup.ts` | Composition root for harness tools | Delegates extension assembly to `DurablePluginRegistry`. AP-014. |
| `src/runner/engine.ts` | Standalone In-Process Engine Facade | Cohesive API (`DurableEngine`) for headless library usage. AP-011, AP-020. |

---

## 5. Tasks (S8 Execution)

### Task 1: Extension Action Parity — `sendUserMessage` & `sendMessage` in Durable FSM (F-99-4)

**Files:**
- Modify: `src/runner/extension-mount.ts:95-115`
- Modify: `src/runner/extension-bridge.ts:130-145`
- Modify: `src/runner/runtime.ts:125-145`
- Test: `tests/extension-user-message.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/extension-user-message.test.ts`:
```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createExtensionActions } from "../src/runner/extension-bridge.ts";
import type { ExtensionActionsDelegate } from "../src/runner/extension-mount.ts";

test("ExtensionActions.sendUserMessage: delegates to onSubmitUserMessage in FSM", async () => {
	let submittedContent = "";
	let submittedBehavior: "steer" | "followUp" | undefined;

	const actionsDelegate: ExtensionActionsDelegate = {
		onSubmitUserMessage: async (content, deliverAs) => {
			submittedContent = content;
			submittedBehavior = deliverAs;
		},
	};

	const actions = createExtensionActions({
		actionsDelegate,
		sessionManager: { appendCustomEntry: () => {} } as any,
	});

	// Verify sendUserMessage delegates properly
	actions.sendUserMessage("Please run task X", { deliverAs: "followUp" });
	assert.equal(submittedContent, "Please run task X");
	assert.equal(submittedBehavior, "followUp");

	// Verify sendMessage with triggerTurn delegates
	submittedContent = "";
	actions.sendMessage({ text: "Message with trigger", triggerTurn: true });
	assert.equal(submittedContent, "Message with trigger");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/extension-user-message.test.ts`
Expected: FAIL with `AssertionError: "" == "Please run task X"` (because `sendUserMessage` is currently `() => {}`).

- [ ] **Step 3: Implement minimal code to make test pass**

1. In `src/runner/extension-mount.ts`, update `ExtensionActionsDelegate`:
```ts
export interface ExtensionActionsDelegate {
	onAbort?: () => void;
	onCompact?: (instructions?: string) => void;
	getContextUsage?: () => { tokens: number | null; contextWindow: number } | undefined;
	isIdle?: () => boolean;
	onConfigureModelTools?: (tools: string[]) => Promise<void> | void;
	onSubmitUserMessage?: (content: string, deliverAs?: "steer" | "followUp") => Promise<void> | void;
}
```

2. In `src/runner/extension-bridge.ts`, wire `sendMessage` and `sendUserMessage`:
```ts
		sendMessage: (message: { text?: string; triggerTurn?: boolean }) => {
			if (message.triggerTurn && message.text) {
				void options.actionsDelegate?.onSubmitUserMessage?.(message.text, "followUp");
			}
		},
		sendUserMessage: (content: string, opts?: { deliverAs?: "steer" | "followUp" }) => {
			void options.actionsDelegate?.onSubmitUserMessage?.(content, opts?.deliverAs);
		},
```

3. In `src/runner/runtime.ts:130`, wire to `controller.submit`:
```ts
		if (activeEnvState.actionsDelegate) {
			activeEnvState.actionsDelegate.onAbort = () => { void controller.abort(); };
			activeEnvState.actionsDelegate.onCompact = (i?: string) => { void controller.compact(i); };
			activeEnvState.actionsDelegate.isIdle = () => true;
			activeEnvState.actionsDelegate.onSubmitUserMessage = async (content: string, deliverAs?: "steer" | "followUp") => {
				await controller.submit(content, deliverAs ?? "followUp");
			};
			...
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/extension-user-message.test.ts`
Expected: PASS (1 test, 0 failures).

- [ ] **Step 5: Commit**

```bash
git add src/runner/extension-mount.ts src/runner/extension-bridge.ts src/runner/runtime.ts tests/extension-user-message.test.ts
git commit -m "feat(extension): implement sendUserMessage and sendMessage delegation to Durable FSM (AP-012, AP-013)"
```

---

### Task 2: Multi-Extension CLI & Session Isolation `--no-global-extensions` (F-99-6, F-99-7)

**Files:**
- Modify: `src/runner/cli-args.ts:30-40`
- Modify: `src/runner/runtime-types.ts:85-95`
- Modify: `src/runner/runtime-loader.ts:75-90`
- Modify: `src/host/session-telemetry.ts:60-75`
- Modify: `src/host/types.ts:30-45`
- Test: `tests/extension-cli-multi.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/extension-cli-multi.test.ts`:
```ts
import test from "node:test";
import assert from "node:assert/strict";
import { parseRunnerCliArgs } from "../src/runner/cli-args.ts";

test("parseRunnerCliArgs: supports multiple --extension flags and --no-global-extensions", () => {
	const argv = [
		"--extension", "/path/to/ext1.ts",
		"--extension", "/path/to/ext2.mjs",
		"--no-global-extensions",
		"--session-dir", "/tmp/sessions",
	];

	const parsed = parseRunnerCliArgs(argv);
	assert.deepEqual(parsed.extensions, ["/path/to/ext1.ts", "/path/to/ext2.mjs"]);
	assert.equal(parsed.noGlobalExtensions, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/extension-cli-multi.test.ts`
Expected: FAIL with `parsed.extensions is undefined` or only contains the last scalar value.

- [ ] **Step 3: Implement minimal code to make test pass**

1. In `src/runner/cli-args.ts`:
```ts
		else if (arg === "--extension" && i + 1 < argv.length) {
			args.extensions ??= [];
			args.extensions.push(argv[++i]);
		}
		else if (arg === "--no-global-extensions") {
			args.noGlobalExtensions = true;
		}
```

2. In `src/runner/runtime-types.ts`:
```ts
	export interface RuntimeCliArgs {
		...
		readonly extensions?: string[];
		readonly noGlobalExtensions?: boolean;
	}
```

3. In `src/runner/runtime-loader.ts:80-90`:
```ts
	const additionalExtensionPaths = [
		...(options.cli?.extensions ?? []),
		...(process.env.PI_ADDITIONAL_EXTENSIONS ? process.env.PI_ADDITIONAL_EXTENSIONS.split(",").map((s) => s.trim()).filter(Boolean) : []),
	];

	const resourceLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		settingsManager,
		modelRuntime,
		extensionFactories: createStandardExtensionFactories(),
		additionalExtensionPaths: additionalExtensionPaths.length > 0 ? additionalExtensionPaths : undefined,
		noExtensions: options.cli?.noGlobalExtensions ?? false,
	});
```

4. In `src/host/types.ts`:
```ts
	export interface SessionOptions {
		...
		additionalExtensionPaths?: string[];
		noGlobalExtensions?: boolean;
	}
```

5. In `src/host/session-telemetry.ts:65`:
```ts
	if (options.additionalExtensionPaths) {
		for (const ext of options.additionalExtensionPaths) {
			args.push("--extension", ext);
		}
	}
	if (options.noGlobalExtensions) {
		args.push("--no-global-extensions");
	}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/extension-cli-multi.test.ts`
Expected: PASS (1 test, 0 failures).

- [ ] **Step 5: Commit**

```bash
git add src/runner/cli-args.ts src/runner/runtime-types.ts src/runner/runtime-loader.ts src/host/types.ts src/host/session-telemetry.ts tests/extension-cli-multi.test.ts
git commit -m "feat(cli): support multiple --extension flags and --no-global-extensions isolation (AP-010, AP-030)"
```

---

### Task 3: POSIX Stdio Transport & Optional FD 3/4 Readiness (F-99-3)

**Files:**
- Modify: `src/runner/bridge-channel.ts`
- Modify: `src/runner/index.ts:165-175`
- Modify: `src/host/runner-process.ts:90-115`
- Test: `tests/posix-stdio-transport.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/posix-stdio-transport.test.ts`:
```ts
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

test("Runner CLI: emits ready frame on stdout in standard POSIX stdio (no FD 3/4)", async () => {
	const runnerBin = resolve("dist/runner/index.js");
	const sessionDir = resolve(tmpdir(), `test-posix-ready-${Date.now()}`);

	const child = spawn(process.execPath, [runnerBin, "--no-session"], {
		stdio: ["pipe", "pipe", "pipe"], // strictly 3 standard descriptors!
	});

	let stdoutData = "";
	const readyPromise = new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Timeout waiting for ready frame")), 4000);
		child.stdout.on("data", (chunk: Buffer) => {
			stdoutData += chunk.toString("utf8");
			for (const line of stdoutData.split("\n")) {
				if (!line.trim()) continue;
				try {
					const parsed = JSON.parse(line);
					if (parsed.type === "ready" || parsed.kind === "ready") {
						clearTimeout(timeout);
						resolve();
					}
				} catch {}
			}
		});
		child.on("error", (err) => { clearTimeout(timeout); reject(err); });
		child.on("exit", (code) => {
			if (code !== 0) { clearTimeout(timeout); reject(new Error(`Exited with ${code}`)); }
		});
	});

	await readyPromise;
	child.kill();
	assert.ok(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/posix-stdio-transport.test.ts`
Expected: FAIL with `Timeout waiting for ready frame` (because `ready` is currently sent exclusively over FD 3).

- [ ] **Step 3: Implement minimal code to make test pass**

1. In `src/runner/bridge-channel.ts`:
```ts
export function createBridgeSender(): (msg: unknown) => void {
	return (msg: unknown) => {
		const str = `${JSON.stringify(msg)}\n`;
		try {
			writeSync(CHILD_TO_BRIDGE_FD, Buffer.from(str, "utf8"));
		} catch (err) {
			// EBADF is completely expected when run in standard POSIX stdio
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code !== "EBADF" && code !== "ENXIO") {
				console.warn(`[BridgeChannel] FD ${CHILD_TO_BRIDGE_FD} write notice: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	};
}
```

2. In `src/runner/index.ts:90` and `index.ts:172`:
```ts
	// Emit canonical ready frame to stdout JSONL (for any POSIX consumer)
	output({ type: "ready", kind: "ready", pid: process.pid });
	// Also mirror to out-of-band FD 3 channel if open
	sendToBridge({ ready: true, kind: "ready", pid: process.pid });
```

3. In `src/host/runner-process.ts`:
In `feedStdio(line)`:
```ts
	if (event.type === "ready" || (event as any).kind === "ready") {
		this.options.onChannelMessage?.({ kind: "ready" });
		return;
	}
```

- [ ] **Step 4: Rebuild runner and run test to verify it passes**

Run: `node scripts/build-runner.mjs && node --test tests/posix-stdio-transport.test.ts`
Expected: PASS (1 test, 0 failures).

- [ ] **Step 5: Commit**

```bash
git add src/runner/bridge-channel.ts src/runner/index.ts src/host/runner-process.ts tests/posix-stdio-transport.test.ts dist/
git commit -m "feat(transport): emit ready frame to stdout for standard POSIX stdio compatibility (AP-021, AP-027)"
```

---

### Task 4: Storage Sovereignty & Elimination of Host Raw SQL (F-99-1, F-99-2)

**Files:**
- Modify: `src/host/durable-binding-store.ts`
- Modify: `src/runner/subagent-watcher.ts`
- Test: `tests/storage-sovereignty.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/storage-sovereignty.test.ts`:
```ts
import test from "node:test";
import assert from "node:assert/strict";
import { DurableBindingManager } from "../src/host/durable-binding-store.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

test("DurableBindingManager: stores and recovers bindings strictly via host sidecar without opening session.sqlite", () => {
	const sessionDir = join(tmpdir(), `test-sidecar-${Date.now()}`);
	mkdirSync(sessionDir, { recursive: true });

	const manager = new DurableBindingManager();
	manager.setSessionDir(sessionDir);

	// Register bindings
	manager.register("thr_child_1", "2", "thr_parent");
	manager.register("thr_child_2", "3", "thr_parent");

	// Verify bindings persist to adapter-bindings.json sidecar
	const sidecarPath = join(sessionDir, "adapter-bindings.json");
	assert.ok(existsSync(sidecarPath));

	// Recover via a fresh manager instance without raw SQL
	const reader = new DurableBindingManager();
	const recovered = reader.readOfflineBindings(sessionDir);

	assert.equal(recovered.length, 2);
	assert.equal(recovered[0].threadId, "thr_child_1");
	assert.equal(recovered[0].conversationId, "2");
	assert.equal(recovered[1].threadId, "thr_child_2");
	assert.equal(recovered[1].conversationId, "3");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/storage-sovereignty.test.ts`
Expected: FAIL because `manager.register` does not currently save directly to `adapter-bindings.json`.

- [ ] **Step 3: Implement minimal code to make test pass**

1. In `src/host/durable-binding-store.ts`:
Implement `saveManifest()` called on `register()` and `unregister()`.
Remove `new DatabaseSync(dbPath, { readOnly: true })` from `readOfflineBindings` completely! The host adapter strictly reads `adapter-bindings.json`.
```ts
	private saveManifest(): void {
		if (!this.sessionDir) return;
		const manifestPath = join(this.sessionDir, "adapter-bindings.json");
		const items: StoredBindingItem[] = Array.from(this.memoryBindings.values());
		try {
			writeFileSync(manifestPath, JSON.stringify(items, null, 2), "utf8");
		} catch (err) {
			console.warn(`[BindingManager] Failed to write adapter-bindings.json: ${err}`);
		}
	}
```
In `readOfflineBindings`:
```ts
	public readOfflineBindings(sessionFilePath: string): StoredBindingItem[] {
		const dir = sessionFilePath.endsWith(".sqlite") ? dirname(sessionFilePath) : sessionFilePath;
		const manifestPath = join(dir, "adapter-bindings.json");
		if (existsSync(manifestPath)) {
			try {
				const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
				if (Array.isArray(parsed)) {
					return parsed.filter((i) => i && typeof i.threadId === "string" && i.conversationId !== undefined);
				}
			} catch (err) {
				console.warn(`[BindingManager] Failed to read adapter manifest: ${err}`);
			}
		}
		return [];
	}
```
2. In `src/runner/subagent-watcher.ts`:
Discover child conversations purely by inspecting `SubagentsDoc.agents` records and tracking integer conversation IDs, without querying host thread IDs.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/storage-sovereignty.test.ts`
Expected: PASS (1 test, 0 failures).

- [ ] **Step 5: Commit**

```bash
git add src/host/durable-binding-store.ts src/runner/subagent-watcher.ts tests/storage-sovereignty.test.ts
git commit -m "feat(storage): decouple host bindings into sidecar store and eliminate raw SQL access to session.sqlite (AP-010, AP-016)"
```

---

### Task 5: Domain & Contract Purification (Purge `PlanStep` and Title Truncation) (F-99-5, F-99-9)

**Files:**
- Modify: `src/contracts/wire-lifecycle.ts`
- Modify: `src/runner/subagent.ts:95-100`
- Modify: `src/runner/subagent-delivery.ts:35-45`
- Modify: `src/host/subthread-spawner.ts:110-120`
- Modify: `src/runner/bridge/durable-event-adapter.ts`
- Modify: `src/host/delta-translator.ts`
- Test: `tests/wire-contract-purity.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/wire-contract-purity.test.ts`:
```ts
import test from "node:test";
import assert from "node:assert/strict";
import { lifecycleSchemas } from "../src/contracts/wire-lifecycle.ts";

test("wire-lifecycle: contains zero presentation schemas (no tasks_snapshot)", () => {
	const types = lifecycleSchemas.map((s) => s.shape.type.value);
	assert.equal(types.includes("tasks_snapshot"), false);
	assert.ok(types.includes("runtime_graph_snapshot"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/wire-contract-purity.test.ts`
Expected: FAIL with `AssertionError: true == false` (because `tasks_snapshot` is currently in `lifecycleSchemas`).

- [ ] **Step 3: Implement minimal code to make test pass**

1. In `src/contracts/wire-lifecycle.ts`:
Remove `planStepSchema`, `tasksSnapshotSchema`, and `tasks_snapshot` from `lifecycleSchemas`.

2. In `src/runner/subagent.ts`:
Remove `nativeChildTitle` from `src/runner/subagent.ts:97` and `src/runner/subagent-delivery.ts:41`. The runner stores the exact task string:
`name: args.task.trim()`.

3. In `src/host/subthread-spawner.ts:115`:
Apply `nativeChildTitle(args.title)` exclusively here when spawning a thread for BB Core.

4. In `src/host/delta-translator.ts`:
Map `runtime_graph_snapshot` to BB's presentation items directly without expecting `tasks_snapshot`.

- [ ] **Step 4: Run test and contract tests to verify pass**

Run: `node --test tests/wire-contract-purity.test.ts && npm run test:contracts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/contracts/wire-lifecycle.ts src/runner/subagent.ts src/runner/subagent-delivery.ts src/host/subthread-spawner.ts src/runner/bridge/durable-event-adapter.ts src/host/delta-translator.ts tests/wire-contract-purity.test.ts
git commit -m "refactor(contracts): purge presentation schemas and column constraints from domain kernel (AP-011, AP-018, AP-026)"
```

---

### Task 6: Strategy Plugin Assembly & In-Process `DurableEngine` Facade (F-99-8, F-99-10)

**Files:**
- Modify: `src/runner/harness-setup.ts:70-110`
- Create: `src/runner/engine.ts`
- Modify: `src/runner/index.ts`
- Test: `tests/durable-engine-facade.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/durable-engine-facade.test.ts`:
```ts
import test from "node:test";
import assert from "node:assert/strict";
import { DurableEngine } from "../src/runner/engine.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("DurableEngine: provides a cohesive in-process facade for headless library usage", async () => {
	const sessionDir = join(tmpdir(), `test-engine-${Date.now()}`);
	const engine = await DurableEngine.open({ sessionDir });
	assert.ok(engine);
	assert.equal(typeof engine.prompt, "function");
	assert.equal(typeof engine.events, "function");
	assert.equal(typeof engine.close, "function");
	await engine.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/durable-engine-facade.test.ts`
Expected: FAIL with `Cannot find module '../src/runner/engine.ts'`.

- [ ] **Step 3: Implement minimal code to make test pass**

1. In `src/runner/harness-setup.ts`:
Update `createCodingRegistry` to accept an optional `pluginRegistry: DurablePluginRegistry` and call `await pluginRegistry.initAll({ cwd, storageDir: ..., registry })`.

2. Create `src/runner/engine.ts`:
Implement `DurableEngine` providing in-process access to `prompt()`, `abort()`, `events()`, and `close()` (< 150 LOC).

3. Export `DurableEngine` from `src/runner/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/durable-engine-facade.test.ts`
Expected: PASS (1 test, 0 failures).

- [ ] **Step 5: Commit**

```bash
git add src/runner/harness-setup.ts src/runner/engine.ts src/runner/index.ts tests/durable-engine-facade.test.ts
git commit -m "feat(engine): implement DurableEngine facade and Strategy plugin assembly (AP-010, AP-014, AP-020)"
```

---

### Task 7: S9 Dual-Circuit Verification Gate & Release v0.4.0

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Build: `node scripts/build-runner.mjs`

- [ ] **Step 1: Run full automated test suite**

Run: `npm test && npm run test:contracts`
Expected: 100% green across all 700+ tests and TypeScript negative contract guards.

- [ ] **Step 2: Execute Two-Circuit Verification (S9 Gate)**

1. **Circuit 1: Architectural Reviewer (`arch-rules-implementation-review`)**
   - Verify line budgets: all files strictly < 200 LOC (hard ceiling 250).
   - Verify zero raw SQL in `src/host/durable-binding-store.ts`.
   - Verify zero `PlanStep` or `tasks_snapshot` in `src/contracts/wire-lifecycle.ts`.
   - Verify zero 500-char column limit references in `src/runner/subagent.ts`.
2. **Circuit 2: Product Reviewer (`arch-improvement-product-review`)**
   - Verify Journey 1: Standalone POSIX execution without FD 3/4.
   - Verify Journey 2: Extension `sendUserMessage` turn submission.
   - Verify Journey 3: Multi-extension isolated session (`--no-global-extensions`).

- [ ] **Step 3: Rebuild runner binary and release**

```bash
node scripts/build-runner.mjs
npm version 0.4.0 --no-git-tag-version
npm install --package-lock-only
git add -A
git commit -m "release: v0.4.0 sovereign hexagonal kernel with full extension parity"
git push origin main
```
