# Arch Improvement Cycle 105: Sovereign Core Rip-and-Replace & Strangler Fig Cutover to Durable Zero

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Полная ликвидация дублирования раннера (Rip-and-Replace) и перевод `bb-plugin-provider-pi-durable` на физическое потребление суверенного ядра `durable-zero` (SSOT), устранение раскола плагинов (Pi Extensions как единственный стандарт расширяемости) и починка автономного CLI `durable-zero serve`.

**Architecture:** Паттерн Мартина Фаулера **Strangler Fig Cutover with Complete Retirement (Branch by Abstraction & Rip-and-Replace)**:
1. `durable-zero` становится единственным источником правды (SSOT) для рантайма, SQLite WAL хранилища, сокет-демона и wire-контрактов.
2. В `durable-zero` устраняется мнимый раскол экосистемы: упраздняется `@durable-zero/sdk`, вырезается `loader.ts` (`plugin.json`), а внутренние модули переименовываются в `EngineSubsystem`. Внешний контракт — строго нативные **Pi Extensions** (`ExtensionAPI`).
3. В `bb-plugin-provider-pi-durable` физически удаляются директории `src/runner/` (56 файлов) и `src/contracts/` (12 файлов). Плагин превращается в чистый Ports & Adapters Consumer хоста Beyond Boundaries.
4. Процесс хоста запускает готовый артефакт `durable-zero`, устраняя ручное копирование (`cp`) и рассинхронизацию двух кодовых баз.

**Tech Stack:** TypeScript (strict mode), Node.js v22/v26, `@durable-zero/core`, `@durable-zero/contracts`, `@earendil-works/pi-coding-agent` 1.5.0, `@earendil-works/pi-durable` 1.5.0, SQLite WAL, QuickJS Wasm, `node:test`.

---

## Architecture Context Map & Invariants

```text
┌────────────────────────────────────────────────────────────────────────┐
│             SOVEREIGN RUNTIME (durable-zero) — SINGLE SOURCE OF TRUTH   │
│                                                                        │
│   • packages/contracts: канонические Zod DTO и wire-протокол           │
│   • packages/core: DurableEngine, SessionDaemon, TaskGraph, Subsystems  │
│   • packages/cli: бинарник durable-zero (doctor, run, serve)           │
│   • 0 импортов @get-bb/* (100% суверенность от платформы)              │
│   • Единый стандарт расширений: 100% Pi ExtensionAPI                   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    │ npm/workspace dependency
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│         CONSUMER HOST ADAPTER (bb-plugin-provider-pi-durable)          │
│                                                                        │
│   • server.ts: регистрация провайдера в BB                             │
│   • src/host/: мост сессий BB, транслятор в threadDeltaSchema          │
│   • app.tsx: React-компоненты десктопа BB                              │
│   • src/runner/ и src/contracts/: ПОЛНОСТЬЮ УДАЛЕНЫ (0 дубликатов)     │
└────────────────────────────────────────────────────────────────────────┘
```

### Applicable AP Rules:
- **AP-010 (Hexagonal / Ports & Adapters):** Провайдер — тонкий адаптер, ядро `durable-zero` полностью суверенно.
- **AP-011 (Thin Adapter Invariant):** Никакой бизнес-логики и дублей раннера в коде плагина.
- **AP-012 (Fail-Fast & Typed Errors):** Строгие Zod-схемы без сырых строк и `any`.
- **AP-013 (Data Integrity & No Fakes):** Честный проброс `sendUserMessage` в FSM очередь.
- **AP-014 (Single Source of Truth / DRY):** Исключение параллельных копий исходников раннера.
- **AP-018 (Ubiquitous Language & Naming):** `BuiltinExtension` (встроенные расширения) вместо вводящего в заблуждение `DurablePlugin` или термина «сабсистем». Вся экосистема объединена вокруг концепции Extension.
- **AP-019 (Line Budgets):** Все файлы < 250 LOC.
- **AP-020 (Dependency Inversion):** Плагин зависит от контрактов `durable-zero`, а не наоборот.
- **AP-021 (Clean CLI Entrypoints):** Починка `durable-zero serve` с корректной передачей `cwd`.
- **AP-026 (Strict DTO Boundaries):** Полная типизация каналов IPC и сокетов.
- **AP-028 (Deterministic Testing):** Тестирование сокета и CLI без зависаний и зомби-процессов.

---

## File Structure & Responsibilities

| File Path | Action | Role & Responsibility | Layer | Line Budget |
|---|---|---|---|---|
| `durable-zero/packages/core/src/runner-server.ts` | Modify | Передача `(args.cwd ?? process.cwd(), args)` в `setupRunnerModels` | Core / Server | < 200 LOC |
| `durable-zero/packages/cli/test/cli.test.ts` | Modify | Исправление ожидаемого формата ready-фрейма и таймаутов | CLI / Test | < 100 LOC |
| `durable-zero/packages/core/src/plugins/external/loader.ts` | Delete | Ликвидация мертвого кода парсинга `plugin.json` | - | 0 LOC |
| `durable-zero/packages/sdk/` | Delete | Ликвидация паразитного дублирующего пакета SDK | - | 0 LOC |
| `durable-zero/packages/plugins/` | Delete | Консолидация подсистем в `packages/core/src/subsystems/` | - | 0 LOC |
| `durable-zero/packages/core/src/builtin-extensions/types.ts` | Create | Определение `BuiltinExtension`, `BuiltinExtensionContext` | Core / Built-in Extensions | < 100 LOC |
| `durable-zero/packages/core/src/builtin-extensions/registry.ts` | Create | Реестр `BuiltinExtensionRegistry` с поддержкой `teardownAll()` | Core / Built-in Extensions | < 150 LOC |
| `durable-zero/packages/core/src/builtin-extensions/codemode.ts` | Create | Встроенное расширение QuickJS WASM песочницы с teardown воркеров | Core / Built-in Extensions | < 100 LOC |
| `durable-zero/packages/core/src/builtin-extensions/subagents.ts` | Create | Встроенное расширение нативных субагентов с курьером и политиками | Core / Built-in Extensions | < 100 LOC |
| `durable-zero/packages/core/src/builtin-extensions/coding-tools.ts` | Create | Встроенное расширение базовых тулов с Photon image processing | Core / Built-in Extensions | < 100 LOC |
| `durable-zero/packages/core/scripts/build-runner.mjs` | Create | Сборка автономного бандла `dist/runner.js` внутри `durable-zero` | Core / Build | < 100 LOC |
| `bb-plugin-provider-pi-durable/src/runner/` | **DELETE ALL** | Полное физическое удаление 56 файлов дубликата раннера | - | 0 LOC |
| `bb-plugin-provider-pi-durable/src/contracts/` | **DELETE ALL** | Удаление 12 файлов дубликатов контрактов (импорт из `@durable-zero/contracts`) | - | 0 LOC |
| `bb-plugin-provider-pi-durable/scripts/build-runner.mjs` | Modify | Получение готового бандла из `durable-zero/packages/core/dist/runner.js` | Host / Build | < 80 LOC |
| `bb-plugin-provider-pi-durable/src/host/runner-process.ts` | Modify | Запуск бандла `durable-zero` через Node.js или сокет-клиент | Host / Process | < 200 LOC |
| `bb-plugin-provider-pi-durable/src/host/bridge.ts` | Modify | Импорты типов строго из `@durable-zero/contracts` | Host / Bridge | < 200 LOC |
| `bb-plugin-provider-pi-durable/src/host/bridge-router.ts` | Modify | Импорты типов строго из `@durable-zero/contracts` | Host / Router | < 200 LOC |

---

## Planned Slices (Arch Rules Slice Planning)

### Slice 1: Починка ядра и CLI в durable-zero (BL-DZ-CLI)
- **Boundary:** Core Entry Point / Server
- **AP gates:** AP-012, AP-021, AP-028
- **Red test first:** `cd /Users/vanya/Projects/durable-zero && npx tsx --test packages/cli/test/cli.test.ts` падает на тесте `CLI: serve --no-session starts server and outputs ready JSON` с `TypeError: Cannot read properties of undefined (reading 'startsWith')`.
- **Implementation:** В `packages/core/src/runner-server.ts:71` вызвать `setupRunnerModels(args.cwd ?? process.cwd(), args)` и выдать ready-фрейм `{ type: "ready", kind: "ready", ready: true, pid: process.pid, mode: "probe" }`. В `cli.test.ts` парсить первую валидную JSONL-строку stdout.
- **Verification:** `cd /Users/vanya/Projects/durable-zero && npx tsx --test packages/cli/test/cli.test.ts` завершается 3/3 pass.
- **Stop condition:** Падение любого из 3 тестов CLI или зависание процесса.

### Slice 2: Ликвидация паразитного @durable-zero/sdk и концепция Built-in Extensions (BL-DZ-EXTENSIONS)
- **Boundary:** Core Built-in Extensions / Public API
- **AP gates:** AP-010, AP-014, AP-018, AP-020
- **Red test first:** `pnpm --filter @durable-zero/sdk exec tsc --noEmit` падает из-за битых импортов `../../policy/types.ts`. Наличие файла `packages/core/src/plugins/external/loader.ts`.
- **Implementation:**
  1. Удалить `packages/core/src/plugins/external/loader.ts`.
  2. Удалить папки `packages/sdk` и `packages/plugins`, удалить их из `pnpm-workspace.yaml`.
  3. В `packages/core/src/builtin-extensions/` создать `types.ts`, `registry.ts`, `codemode.ts`, `subagents.ts`, `coding-tools.ts`.
  4. Переименовать `DurablePlugin` $\to$ `BuiltinExtension`, `DurablePluginRegistry` $\to$ `BuiltinExtensionRegistry`.
  5. В `README.md` явно задокументировать: «Всё в системе — это Extensions: встроенные (built-in) в ядре и пользовательские через стандартный Pi ExtensionAPI (`.pi/extensions/`)».
- **Verification:** `cd /Users/vanya/Projects/durable-zero && pnpm test` и `pnpm -r exec tsc --noEmit` проходят с нулевыми ошибками.
- **Stop condition:** Ошибки компиляции TypeScript или ссылки на `DurablePlugin`.

### Slice 3: Автономная сборка раннера в durable-zero (BL-DZ-BUNDLE)
- **Boundary:** Infrastructure / Build Artifacts
- **AP gates:** AP-014, AP-021
- **Red test first:** Отсутствие исполняемого бандла `packages/core/dist/runner.js`.
- **Implementation:**
  1. Создать скрипт `packages/core/scripts/build-runner.mjs`.
  2. Использовать esbuild для сборки `packages/core/src/runner-server.ts` в `packages/core/dist/runner.js`.
  3. Скопировать `quickjs.wasm` в `packages/core/dist/quickjs.wasm`.
  4. В `packages/core/package.json` добавить `"build:runner": "node scripts/build-runner.mjs"` и экспорт `"./runner": "./dist/runner.js"`.
- **Verification:** `node packages/core/dist/runner.js --version` выводит версию рантайма без падений.
- **Stop condition:** Сбои разрешения внешних модулей или отсутствие WASM.

### Slice 4: Физический Rip-and-Replace в bb-plugin-provider-pi-durable (BL-BB-CUTOVER)
- **Boundary:** Host Adapter / Rip-and-Replace
- **AP gates:** AP-010, AP-011, AP-014, AP-020
- **Red test first:** Наличие 56 файлов в `src/runner/` и 12 файлов в `src/contracts/`.
- **Implementation:**
  1. Выполнить `git rm -r src/runner src/contracts`.
  2. В `src/host/`: заменить относительные импорты из `../contracts/*` на `@durable-zero/contracts`.
  3. В `scripts/build-runner.mjs`: копировать готовый бандл `dist/runner/index.js` и `quickjs.wasm` из `durable-zero/packages/core/dist/`.
  4. В `src/host/paths.ts`: разрешать раннер из собранного `dist/runner/index.js`.
  5. В `package.json` зафиксировать зависимость на `@durable-zero/core` и `@durable-zero/contracts`.
- **Verification:** `npm run build` успешно собирает плагин, `node scripts/verify-layer-boundaries.mjs` фиксирует 0 нарушений.
- **Stop condition:** Наличие файлов в `src/runner/` или неразрешённые импорты контрактов.

### Slice 5: Сквозная верификация и подтверждение работы (BL-E2E-PASS)
- **Boundary:** End-to-End Integration
- **AP gates:** AP-013, AP-026, AP-028
- **Implementation:**
  1. Запуск сквозных IPC тестов `node --test tests/e2e-bb-tools-ipc.test.ts`.
  2. Запуск UI тестов `npx tsx --test tests/ui/*.test.ts`.
  3. Запуск `npm run doctor` в `bb-plugin-provider-pi-durable`.
  4. Запуск `node packages/cli/bin/durable-zero.js doctor` в `durable-zero`.
- **Verification:** 100% оставшихся интеграционных тестов проходят, 0 дубликатов раннера.
- **Stop condition:** Падение любого сквозного теста или регрессия дельт интерфейса.

---

## Detailed Task Breakdown

### Task 1: Починка `runner-server.ts` и `cli.test.ts` в `durable-zero`

**Files:**
- Modify: `durable-zero/packages/core/src/runner-server.ts:70-76`
- Modify: `durable-zero/packages/cli/test/cli.test.ts:25-45`
- Test: `durable-zero/packages/cli/test/cli.test.ts`

- [ ] **Step 1: Исправить передачу cwd и аргументов в runner-server.ts**

В файле `packages/core/src/runner-server.ts` заменить блок `if (args.noSession)`:
```ts
	if (args.noSession) {
		const cwd = args.cwd ?? process.cwd();
		const { modelRuntime } = await setupRunnerModels(cwd, args);
		output({ type: "ready", kind: "ready", ready: true, pid: process.pid, mode: "probe" });
		const scopedList = modelRuntime.getAvailableSnapshot();
		const scopedModelIds = scopedList.map((m) => `${m.provider}/${m.id}`);
		const defaultModel = modelRuntime.findDefaultModel();
		const defaultModelId = defaultModel ? `${defaultModel.provider}/${defaultModel.id}` : undefined;
		const modelScope = { scopedModelIds, defaultModelId };
		initBridgeInboundChannel(modelScope, sendToBridge);
		return;
	}
```

- [ ] **Step 2: Исправить парсер фрейма в packages/cli/test/cli.test.ts**

В файле `packages/cli/test/cli.test.ts` обновить тест:
```ts
test("CLI: serve --no-session starts server and outputs ready JSON", async () => {
	const p = cp.spawn("node", [CLI_PATH, "serve", "--no-session"], {
		stdio: ["pipe", "pipe", "pipe"],
	});

	try {
		const readyData = await new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Timeout waiting for ready")), 4000);
			let buffer = "";
			p.stdout.on("data", (chunk) => {
				buffer += chunk.toString("utf8");
				const lines = buffer.split("\n");
				for (const line of lines) {
					const trimmed = line.trim();
					if (trimmed.startsWith("{") && trimmed.includes('"ready"')) {
						clearTimeout(timer);
						resolve(trimmed);
						return;
					}
				}
			});
			p.once("error", reject);
		});

		const parsed = JSON.parse(readyData);
		assert.equal(parsed.ready, true);
		assert.ok(parsed.pid > 0);
	} finally {
		p.kill("SIGTERM");
	}
});
```

- [ ] **Step 3: Запустить тесты CLI и подтвердить green**

Run: `cd /Users/vanya/Projects/durable-zero && npx tsx --test packages/cli/test/cli.test.ts`
Expected:
```text
✔ CLI: --version prints version string
✔ CLI: doctor checks runtime capabilities
✔ CLI: serve --no-session starts server and outputs ready JSON
ℹ tests 3
ℹ pass 3
ℹ fail 0
```

- [ ] **Step 4: Закоммитить в durable-zero**

```bash
cd /Users/vanya/Projects/durable-zero
git add packages/core/src/runner-server.ts packages/cli/test/cli.test.ts
git commit -m "fix(core): pass cwd to setupRunnerModels and emit valid pid in ready frame"
```

---

### Task 2: Ликвидация `@durable-zero/sdk`, `@durable-zero/plugins` и перевод в `packages/core/src/builtin-extensions/`

**Files:**
- Create: `durable-zero/packages/core/src/builtin-extensions/types.ts`
- Create: `durable-zero/packages/core/src/builtin-extensions/registry.ts`
- Create: `durable-zero/packages/core/src/builtin-extensions/codemode.ts`
- Create: `durable-zero/packages/core/src/builtin-extensions/subagents.ts`
- Create: `durable-zero/packages/core/src/builtin-extensions/coding-tools.ts`
- Create: `durable-zero/packages/core/test/builtin-extension-registry.test.ts`
- Delete: `durable-zero/packages/core/src/plugins/external/loader.ts`
- Delete: `durable-zero/packages/core/src/plugins/`
- Delete: `durable-zero/packages/sdk/`
- Delete: `durable-zero/packages/plugins/`
- Modify: `durable-zero/packages/core/src/harness-setup.ts:15-35`
- Modify: `durable-zero/packages/core/src/runtime-loader.ts:15-30`
- Modify: `durable-zero/packages/core/package.json:10-25`
- Modify: `durable-zero/pnpm-workspace.yaml:1-5`
- Modify: `durable-zero/README.md`

- [ ] **Step 1: Создать типы встроенных расширений в packages/core/src/builtin-extensions/types.ts**

```ts
import type { Registry } from "@earendil-works/pi-durable";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { SubagentPolicyRecord } from "../policy/types.ts";
import type { PromptOptions } from "../prompt.ts";
import type { DynamicCodemodeNamespaces } from "../codemode-namespaces.ts";

export interface BuiltinExtensionContext {
	cwd: string;
	storageDir?: string;
	registry?: Registry;
	settingsManager?: SettingsManager;
	getSubagentPolicy?: () => SubagentPolicyRecord;
	prompt?: PromptOptions;
	dynamicNamespaces?: DynamicCodemodeNamespaces;
}

export interface BuiltinExtension {
	readonly id: string;
	readonly name: string;
	readonly version: string;
	register(ctx: BuiltinExtensionContext): Promise<void> | void;
	teardown?(): Promise<void> | void;
}
```

- [ ] **Step 2: Создать реестр встроенных расширений в packages/core/src/builtin-extensions/registry.ts**

```ts
import { EngineExtensionError } from "../shared/errors.ts";
import type { BuiltinExtension, BuiltinExtensionContext } from "./types.ts";

export class BuiltinExtensionRegistry {
	readonly #extensions = new Map<string, BuiltinExtension>();

	register(extension: BuiltinExtension): void {
		if (this.#extensions.has(extension.id)) {
			throw new EngineExtensionError(
				extension.id,
				`Built-in extension with id '${extension.id}' is already registered`,
			);
		}
		this.#extensions.set(extension.id, extension);
	}

	get(id: string): BuiltinExtension | undefined {
		return this.#extensions.get(id);
	}

	list(): BuiltinExtension[] {
		return Array.from(this.#extensions.values());
	}

	async initAll(ctx: BuiltinExtensionContext): Promise<void> {
		for (const extension of this.#extensions.values()) {
			try {
				await extension.register(ctx);
			} catch (err) {
				if (err instanceof EngineExtensionError) throw err;
				throw new EngineExtensionError(
					extension.id,
					`Failed to initialize built-in extension '${extension.id}': ${err instanceof Error ? err.message : String(err)}`,
					{ cause: err },
				);
			}
		}
	}

	async teardownAll(): Promise<void> {
		const extensions = Array.from(this.#extensions.values()).reverse();
		for (const extension of extensions) {
			if (typeof extension.teardown === "function") {
				try {
					await extension.teardown();
				} catch {
					// Gracefully proceed with other teardowns
				}
			}
		}
	}
}
```

- [ ] **Step 3: Перенести встроенные расширения в packages/core/src/builtin-extensions/**

Создать `coding-tools.ts`, `codemode.ts`, `subagents.ts` в `packages/core/src/builtin-extensions/`, импортирующие `BuiltinExtension` и `BuiltinExtensionContext`.

- [ ] **Step 4: Написать юнит-тест для BuiltinExtensionRegistry**

В файле `packages/core/test/builtin-extension-registry.test.ts`:
```ts
import test from "node:test";
import assert from "node:assert/strict";
import { BuiltinExtensionRegistry } from "../src/builtin-extensions/registry.ts";
import type { BuiltinExtension } from "../src/builtin-extensions/types.ts";

test("BuiltinExtensionRegistry registers and runs teardownAll in reverse order", async () => {
	const registry = new BuiltinExtensionRegistry();
	const order: string[] = [];

	const e1: BuiltinExtension = {
		id: "e1",
		name: "Extension 1",
		version: "1.0.0",
		register: () => {},
		teardown: () => { order.push("e1"); },
	};
	const e2: BuiltinExtension = {
		id: "e2",
		name: "Extension 2",
		version: "1.0.0",
		register: () => {},
		teardown: () => { order.push("e2"); },
	};

	registry.register(e1);
	registry.register(e2);

	await registry.teardownAll();
	assert.deepEqual(order, ["e2", "e1"]);
});
```

- [ ] **Step 5: Удалить packages/sdk, packages/plugins и loader.ts**

Удалить каталоги и ссылки:
```bash
cd /Users/vanya/Projects/durable-zero
rm -rf packages/sdk packages/plugins packages/core/src/plugins
```
Обновить `pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
```
Удалить `@durable-zero/sdk` и `@durable-zero/plugins` из зависимостей `packages/core/package.json` и `packages/cli/package.json`.

- [ ] **Step 6: Обновить README.md**

Задокументировать:
```markdown
## Extensibility

`durable-zero` uses standard **Pi Extensions** (`.pi/extensions/` or `--extension <path>`).
There are no custom plugin manifests or separate plugin SDKs. Write standard extensions with `export default function(pi: ExtensionAPI)` and register tools, hooks, and MCP servers natively.
```

- [ ] **Step 7: Запустить тесты и коммит**

Run: `cd /Users/vanya/Projects/durable-zero && npx tsx --test packages/core/test/*.test.ts packages/cli/test/cli.test.ts`
Expected: All tests pass.
Commit:
```bash
git add -A
git commit -m "refactor(core): consolidate built-in extensions into core and eliminate redundant sdk package"
```

---

### Task 3: Автономная сборка раннера в `durable-zero`

**Files:**
- Create: `durable-zero/packages/core/scripts/build-runner.mjs`
- Modify: `durable-zero/packages/core/package.json:15-30`
- Test: `node durable-zero/packages/core/dist/runner.js --help`

- [ ] **Step 1: Создать скрипт сборки packages/core/scripts/build-runner.mjs**

```js
#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { builtinModules } from "node:module";
import fs from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const projectRoot = resolve(packageRoot, "../..");

console.log("Building durable-zero standalone runner bundle...");

await build({
	entryPoints: [resolve(packageRoot, "src/runner-server.ts")],
	bundle: true,
	platform: "node",
	target: "node22",
	format: "esm",
	outfile: resolve(packageRoot, "dist/runner.js"),
	external: [
		...builtinModules,
		...builtinModules.map((m) => `node:${m}`),
		"@earendil-works/pi-durable",
		"@earendil-works/pi-durable/*",
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-coding-agent/*",
		"@earendil-works/pi-codemode",
		"@earendil-works/pi-codemode/*",
		"@earendil-works/pi-ai",
		"@earendil-works/pi-ai/*",
		"@earendil-works/chord",
		"@earendil-works/chord/*",
		"@earendil-works/pi-schema",
		"@earendil-works/pi-schema/*",
		"@sinclair/typebox",
		"@sinclair/typebox/*",
		"proper-lockfile",
		"zod",
		"zod/*",
	],
	banner: {
		js: `import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);`,
	},
	sourcemap: true,
});

console.log("Built packages/core/dist/runner.js successfully!");

try {
	const wasmSource = resolve(projectRoot, "node_modules/quickjs-wasi/quickjs.wasm");
	const wasmDest = resolve(packageRoot, "dist/quickjs.wasm");
	await fs.copyFile(wasmSource, wasmDest);
	console.log("Copied quickjs.wasm successfully!");
} catch (err) {
	console.warn("quickjs.wasm copy warning:", err.message);
}
```

- [ ] **Step 2: Добавить скрипт и экспорт в packages/core/package.json**

В секцию `scripts`:
```json
"build:runner": "node scripts/build-runner.mjs"
```
В секцию `exports`:
```json
"./runner": "./dist/runner.js"
```

- [ ] **Step 3: Собрать бандл и проверить запуск**

Run: `cd /Users/vanya/Projects/durable-zero/packages/core && node scripts/build-runner.mjs`
Run: `node dist/runner.js --help`
Expected: Процесс запускается и выводит справку.

- [ ] **Step 4: Закоммитить в durable-zero**

```bash
cd /Users/vanya/Projects/durable-zero
git add packages/core/scripts/build-runner.mjs packages/core/package.json packages/core/dist/
git commit -m "feat(core): export pre-built standalone runner bundle"
```

---

### Task 4: Физический Rip-and-Replace старого раннера в `bb-plugin-provider-pi-durable`

**Files:**
- Delete: `bb-plugin-provider-pi-durable/src/runner/` (all 56 files)
- Delete: `bb-plugin-provider-pi-durable/src/contracts/` (all 12 files)
- Modify: `bb-plugin-provider-pi-durable/src/host/bridge.ts`
- Modify: `bb-plugin-provider-pi-durable/src/host/bridge-router.ts`
- Modify: `bb-plugin-provider-pi-durable/src/host/session.ts`
- Modify: `bb-plugin-provider-pi-durable/src/host/session-port.ts`
- Modify: `bb-plugin-provider-pi-durable/src/host/runner-process.ts`
- Modify: `bb-plugin-provider-pi-durable/src/host/paths.ts`
- Modify: `bb-plugin-provider-pi-durable/scripts/build-runner.mjs`
- Modify: `bb-plugin-provider-pi-durable/package.json`

- [ ] **Step 1: Физически удалить дубликаты src/runner/ и src/contracts/**

```bash
cd /Users/vanya/Projects/bb-plugin-provider-pi-durable
git rm -rf src/runner src/contracts
```

- [ ] **Step 2: Заменить импорты контрактов в src/host/ на @durable-zero/contracts**

Во всех файлах `src/host/*.ts` заменить:
`from "../contracts/..."` $\to$ `from "@durable-zero/contracts"`

- [ ] **Step 3: Обновить scripts/build-runner.mjs в плагине**

Переписать `scripts/build-runner.mjs` так, чтобы он не компилировал раннер из локальных исходников, а разворачивал готовый артефакт из пакета `durable-zero`:
```js
#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

console.log("Deploying durable-zero pre-built runner to plugin dist...");

const runnerSource = resolve(projectRoot, "../durable-zero/packages/core/dist/runner.js");
const runnerDestDir = resolve(projectRoot, "dist/runner");
const runnerDest = resolve(runnerDestDir, "index.js");

await fs.mkdir(runnerDestDir, { recursive: true });

if (existsSync(runnerSource)) {
	await fs.copyFile(runnerSource, runnerDest);
	console.log("Deployed runner from local durable-zero packages/core/dist/runner.js!");
} else {
	// Fallback to npm package resolution if installed
	const pkgRunner = resolve(projectRoot, "node_modules/@durable-zero/core/dist/runner.js");
	await fs.copyFile(pkgRunner, runnerDest);
	console.log("Deployed runner from @durable-zero/core npm package!");
}

const wasmSource = resolve(projectRoot, "../durable-zero/packages/core/dist/quickjs.wasm");
const wasmDest = resolve(runnerDestDir, "quickjs.wasm");
if (existsSync(wasmSource)) {
	await fs.copyFile(wasmSource, wasmDest);
	console.log("Deployed quickjs.wasm!");
}

console.log("Runner deployment complete.");
```

- [ ] **Step 4: Запустить сборку плагина и фаервол слоев**

Run: `cd /Users/vanya/Projects/bb-plugin-provider-pi-durable && npm run build`
Run: `node scripts/verify-layer-boundaries.mjs`
Expected: Сборка успешна, 0 нарушений фаервола слоёв.

- [ ] **Step 5: Удалить невалидные тесты локального runner из tests/**

Удалить тесты, проверявшие приватные удалённые файлы `src/runner/plugins/*` и переключить сьют тестов на тестирование хоста и сквозного IPC.

- [ ] **Step 6: Закоммитить в bb-plugin-provider-pi-durable**

```bash
cd /Users/vanya/Projects/bb-plugin-provider-pi-durable
git add -A
git commit -m "refactor(host): rip-and-replace legacy runner in favor of sovereign durable-zero core"
```

---

### Task 5: Сквозная верификация и гейт S9 (Dual-Circuit PASS)

**Files:**
- Test: `bb-plugin-provider-pi-durable/tests/e2e-bb-tools-ipc.test.ts`
- Test: `bb-plugin-provider-pi-durable/tests/ui/*.test.ts`
- Modify: `bb-plugin-provider-pi-durable/docs/arch-improvement/ledger.md`
- Modify: `bb-plugin-provider-pi-durable/docs/arch-improvement/memory.md`

- [ ] **Step 1: Прогнать сквозной тест IPC**

Run: `cd /Users/vanya/Projects/bb-plugin-provider-pi-durable && node --test tests/e2e-bb-tools-ipc.test.ts`
Expected: PASS.

- [ ] **Step 2: Запустить полный тестовый сьют хоста и UI**

Run: `cd /Users/vanya/Projects/bb-plugin-provider-pi-durable && npm run test`
Expected: 100% PASS.

- [ ] **Step 3: Запустить doctor в обоих репозиториях**

Run: `cd /Users/vanya/Projects/bb-plugin-provider-pi-durable && npm run doctor`
Expected: HEALTHY.
Run: `cd /Users/vanya/Projects/durable-zero && node packages/cli/bin/durable-zero.js doctor`
Expected: HEALTHY.

- [ ] **Step 4: Зафиксировать результаты в ledger.md и memory.md**

Добавить запись Cycle 105 в `docs/arch-improvement/ledger.md` со всеми чеками и метриками.

- [ ] **Step 5: Закоммитить итоговый релиз**

```bash
cd /Users/vanya/Projects/bb-plugin-provider-pi-durable
git add -A
git commit -m "feat(release): complete Cycle 105 rip-and-replace cutover to durable-zero SSOT"
```
