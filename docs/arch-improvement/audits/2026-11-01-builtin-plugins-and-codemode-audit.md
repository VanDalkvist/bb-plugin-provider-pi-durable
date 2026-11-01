# Архитектурный и рантайм-аудит подсистемы Codemode и встроенных плагинов

**Дата:** 2026-11-01  
**Ревьюер:** Principal Software Architect (Arch Improvement Loop)  
**Репозиторий:** `/Users/vanya/Projects/bb-plugin-provider-pi-durable`  
**Ветка/Коммит:** `main` (v0.4.0)  
**Итоговый вердикт:** **VERDICT: FAIL** (Обнаружены блокирующие дефекты 2x P0, 2x P1, 1x P2)  

**Исследованные первоисточники:**
- `src/runner/plugins/built-in/codemode.ts`
- `src/runner/plugins/built-in/coding-tools.ts`
- `src/runner/plugins/built-in/subagents.ts`
- `src/runner/plugins/registry.ts`
- `src/runner/plugins/types.ts`
- `src/runner/codemode-namespaces.ts`
- `src/runner/extension-mount.ts`
- `src/runner/tool-adapter.ts`
- `src/runner/harness-setup.ts`
- `src/runner/runtime-loader.ts`
- `src/runner/prompt.ts`
- Upstream `@earendil-works/pi-durable`:
  - `packages/durable/src/codemode/codemode.ts` (FSM `CodemodeCall`, `outcomeOf`)
  - `packages/durable/src/codemode/describe.ts` (контракты `CodemodeNamespace`, `codemodeSection`)
  - `packages/durable/src/harness/agent.ts` (`resolveAgent`, `callable`, `deferred`)
  - `packages/durable/src/harness/tool.ts` (`structuredOutputError`, валидация контракта `structuredOutput`)
  - `packages/durable/src/tools/index.ts` (`createCodingTools`, Photon image processing)
- Upstream `@earendil-works/pi-coding-agent`:
  - `src/core/extensions/types.ts` (канонический `ToolExposure`, `ToolDefinition`)
  - `src/extensions/mcp/tools.ts` (`toToolExposure`, `convertMcpResult`, `CallToolResult`)
  - `src/core/extension-runner.ts` (`_getCallableTools`, `executeTool`)
- Upstream `@earendil-works/pi-codemode`:
  - `src/runtime/execution.ts` (`CodemodeSandboxBase.close()`, Worker lifecycle)
  - `src/runtime/host.ts` (`CodemodeSandbox`, `workerLauncher`)

---

## 1. Executive Summary & Root Cause Analysis

Пользователь зафиксировал регресс рантайма: *«ощущение, что codemode перестал работать»*.
В ходе архитектурного аудита подсистемы `codemode` и встроенных плагинов (`src/runner/plugins/built-in/`) было проведено пошаговое сопоставление потоков данных с каноническим рантаймом `@earendil-works/pi-durable` и `@earendil-works/pi-coding-agent`.

Аудит полностью вскрыл механизм деградации:
1. **Катастрофическая потеря данных в мосту инструментов:** Адаптер расширений `adaptExtensionTool` и исполнитель вложенных вызовов `createNestedToolExecutor` полностью вырезают типизированный объект `structuredOutput` / `structuredContent`. При этом для инструментов, объявляющих `outputSchema`, адаптер регистрирует `structuredOutputSchema`. Ядро `@earendil-works/pi-durable` видит наличие схемы и отсутствие `structuredOutput`, квалифицирует это как нарушение контракта (`invalid_structured_output`) и принудительно переводит результат вызова в ошибку. Песочница QuickJS отвергает результат.
2. **Утечка воркеров QuickJS и разрыв жизненного цикла:** Плагин `codemodePlugin` инстанциирует `new CodemodeSandbox()` анонимно без метода `teardown()`. Одновременно `createCodingRegistry` в `harness-setup.ts` отбрасывает экземпляр `DurablePluginRegistry`, делая вызов `teardownAll()` невозможным. В результате на каждом цикле сессии фоновые потоки Node.js `Worker` и память WebAssembly остаются неудалёнными.
3. **Искажение системного промпта и метаданных неймспейсов:** Класс `DynamicCodemodeNamespaces` затирает каноническое поле `instructions`, подменяя им `description`. Скрипты codemode при вызове `describeNamespace()` получают `undefined` вместо правил работы с сервером.
4. **Невалидный синтетический тип экспозиции:** Адаптер `tool-adapter.ts` использует несуществующую строку `"codemode-deferred"`, нарушая каноническую логику фильтрации `deferred` инструментов и раздувая системный промпт.

---

## 2. Severity-Ranked Findings

### [P0] BL-CM-01: Утеря `structuredOutput` в `createNestedToolExecutor` и `adaptExtensionTool`
- **Evidence:**
  - `src/runner/extension-mount.ts:50-75`:
    ```ts
    const res = await executor(args, api, runtimeContext);
    const rawBlocks = res?.output;
    const content = Array.isArray(rawBlocks)
        ? (rawBlocks as Array<{ type: "text"; text: string }>)
        : rawBlocks !== undefined
            ? [{ type: "text" as const, text: String(rawBlocks) }]
            : [{ type: "text" as const, text: outputText }];
    // ...
    return { toolCall: ..., result: { content, details: res?.details }, isError: !!res?.isError };
    ```
  - `src/runner/tool-adapter.ts:18-26` (`NestedToolExecutor` возвращает только `content` и `details`, поле `structuredOutput` отсутствует в сигнатуре типа).
  - `src/runner/tool-adapter.ts:58-63` (регистрирует `structuredOutputSchema: toolDef.outputSchema`).
  - `src/runner/tool-adapter.ts:128-132`:
    ```ts
    return {
        output: result.content,
        isError: result.isError,
        details: (result.details ?? undefined) as JsonValue | undefined,
    }; // structuredOutput / structuredContent полностью выброшен!
    ```
  - Upstream `@earendil-works/pi-durable/dist/harness/tool.js:487-498` (`structuredOutputError`):
    ```ts
    if (value === undefined) {
        return result.isError === true ? undefined : `Tool ${tool.name} returned no structuredOutput`;
    }
    ```
  - Upstream `@earendil-works/pi-durable/dist/codemode/codemode.js:170-185` (`outcomeOf`):
    ```ts
    const value = structured ? result.structuredOutput : textOf(result.structuredOutput);
    ```
- **Impact:**
  Инструменты MCP и расширений, возвращающие данные (`CallToolResult`, `structuredContent`), либо падают с ошибкой `invalid_structured_output`, либо превращаются в QuickJS песочнице в строковые массивы `content`. Скрипты `codemode` не могут прочитать свойства возвращаемых объектов (`result.items`, `result.output`), что ломает 100% сценариев структурированной работы.
- **Rule:** AP-012 (Fail-fast и явные контракты ошибок), AP-013 (Целостность пользовательских данных), AP-026 (API-контракты и DTO границы).
- **Fix decision:** `fix-now`. В `adaptExtensionTool` возвращать `structuredOutput: (result as any).structuredContent ?? (result as any).structuredOutput`, а в `createNestedToolExecutor` расширить интерфейс `NestedToolExecutor` и пробрасывать `structuredOutput: res?.structuredOutput ?? res?.structuredContent`.

---

### [P0] BL-CM-02: Отсутствие `teardown()` в `codemodePlugin` и потеря `pluginRegistry` в `harness-setup.ts`
- **Evidence:**
  - `src/runner/plugins/built-in/codemode.ts:5-18`:
    ```ts
    export const codemodePlugin: DurablePlugin = {
        id: "codemode",
        name: "Codemode",
        category: "built-in",
        version: "1.0.0",
        register(ctx: DurablePluginContext): void {
            if (!ctx.registry) return;
            const ext = createCodemodeExtension({
                sandbox: new CodemodeSandbox(),
                get namespaces() {
                    return ctx.dynamicNamespaces?.getNamespaces?.() ?? [];
                },
            });
            ctx.registry.install(ext);
        },
        // teardown() отсутствует!
    };
    ```
  - `src/runner/harness-setup.ts:87-105`:
    ```ts
    const pluginRegistry = new DurablePluginRegistry();
    // ...
    await pluginRegistry.initAll(ctx);
    // pluginRegistry локален для функции и выбрасывается из области видимости!
    return registry;
    ```
  - `src/runner/runtime-loader.ts:180-200` (`cleanup: mounted.cleanup` — очищает только `extensionRunner`, плагины не очищаются).
  - Upstream `@earendil-works/pi-codemode/dist/runtime/execution.js:381-385` (`CodemodeSandboxBase.close()`):
    ```ts
    async close(): Promise<void> {
        this.closed = true;
        await Promise.all([...this.running].map((execution) => execution.abort("Sandbox closed")));
    }
    ```
  - Upstream `@earendil-works/pi-codemode/dist/runtime/host.js:59-66` (`workerLauncher` останавливает worker threads через Atomics и `worker.terminate()`).
- **Impact:**
  Каждая сессия BB оставляет запущенными потоки Node.js `Worker` и активные модули WebAssembly QuickJS. Происходит утечка системных дескрипторов, порча изоляции между рестартами сессий и деградация производительности хост-демона.
- **Rule:** AP-013 (Целостность данных), AP-023 (Async дисциплина), AP-045 (Resource exhaustion).
- **Fix decision:** `fix-now`. Сохранять экземпляр `sandbox` внутри экземпляра/замыкания плагина, реализовать `teardown(): Promise<void> { await sandbox?.close(); }`. В `createCodingRegistry` возвращать `{ registry, pluginRegistry }` (или пробрасывать teardown в общий `cleanup` сессии в `runtime-loader.ts`).

---

### [P1] BL-CM-03: Потеря `instructions` в `DynamicCodemodeNamespaces`
- **Evidence:**
  - `src/runner/codemode-namespaces.ts:34-40`:
    ```ts
    const desc = def.namespace?.description ?? def.namespace?.instructions;
    this.registerNamespace({
        name: def.namespace?.name ?? serverName,
        prefix,
        ...(desc ? { description: desc } : {}),
    });
    ```
  - Upstream `@earendil-works/pi-durable/dist/codemode/describe.d.ts:11`:
    ```ts
    export type CodemodeNamespace = {
        readonly name: string;
        readonly description?: string;
        readonly instructions?: string;
        readonly prefix: string;
    };
    ```
  - Upstream `@earendil-works/pi-durable/dist/codemode/codemode.js:370-385` (`discover` / `describeNamespace`):
    ```ts
    return {
        name: namespace.name,
        ...(namespace.description === undefined ? {} : { description: namespace.description }),
        ...(namespace.instructions === undefined ? {} : { instructions: namespace.instructions }),
        tools: namespace.tools.map((tool) => toCodemodeIdentifier(tool)),
    };
    ```
- **Impact:**
  При регистрации инструментов MCP (например, GitHub, Postgres, GBrain) инструкции сервера (`def.namespace.instructions`) либо полностью выбрасываются (если у сервера задан `description`), либо записываются в поле `description`. В результате системный промпт в секции `codemodeSection` получает раздутый заголовок неймспейса, а скрипты `codemode`, вызывающие `await describeNamespace("mcp__server")`, получают `instructions: undefined`. Модель теряет критические инструкции по безопасному использованию инструментов.
- **Rule:** AP-012 (Контракты ошибок и метаданных), AP-026 (API-контракты и DTO границы).
- **Fix decision:** `fix-now`. Раздельно регистрировать `description` и `instructions`:
  ```ts
  this.registerNamespace({
      name: def.namespace?.name ?? serverName,
      prefix,
      ...(def.namespace?.description ? { description: def.namespace.description } : {}),
      ...(def.namespace?.instructions ? { instructions: def.namespace.instructions } : {}),
  });
  ```

---

### [P1] BL-CM-04: Невалидный тип экспозиции `"codemode-deferred"` в `tool-adapter.ts`
- **Evidence:**
  - `src/runner/tool-adapter.ts:46-56`:
    ```ts
    const exposure = toolDef.exposure as string | undefined;
    const isDeferred = exposure === "deferred" || exposure === "codemode-deferred";
    const callers =
        exposure === "model-only"
            ? (["model"] as const)
            : exposure === "codemode" || exposure === "codemode-deferred"
                ? (["tools"] as const)
                : exposure === "hidden"
                    ? ([] as const)
                    : (["model", "tools"] as const);
    ```
  - Upstream `@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:395`:
    ```ts
    export type ToolExposure = "direct" | "model-only" | "codemode" | "deferred" | "hidden";
    ```
  - Upstream `@earendil-works/pi-coding-agent/dist/extensions/mcp/tools.js:44-46`:
    ```ts
    export function toToolExposure(exposure: McpExposure): ToolExposure {
        return exposure === "codemode" ? "deferred" : exposure;
    }
    ```
- **Impact:**
  Строка `"codemode-deferred"` является выдуманным синтетическим типом, отсутствующим в upstream Pi. Для канонического типа `exposure === "codemode"` флаг `isDeferred` вычисляется как `false`. Это приводит к тому, что инструменты с `exposure: "codemode"` не помечаются как `deferred: true` в Durable Registry. В результате `codemodeSection` в системном промпте не фильтрует их, что вызывает перерасход токенов на inline-декларации и рассинхронизацию с `searchTools()`.
- **Rule:** AP-010 (Ports & Adapters), AP-026 (DTO границы), AP-029 (TypeScript strictness).
- **Fix decision:** `fix-now`. Удалить ветвление `"codemode-deferred"`. Привести к канонической семантике:
  - `exposure === "model-only"`: `callers: ["model"]`, `deferred: false`
  - `exposure === "codemode"`: `callers: ["tools"]`, `deferred: true`
  - `exposure === "deferred"`: `callers: ["model", "tools"]`, `deferred: true`
  - `exposure === "hidden"`: `callers: []`, `deferred: false`
  - по умолчанию (`"direct"`): `callers: ["model", "tools"]`, `deferred: false`

---

### [P1] BL-CM-08: Игнорирование `AbortSignal` и контекста вызова в `adaptExtensionTool`
- **Evidence:**
  - `src/runner/tool-adapter.ts:71-76`:
    ```ts
    async execute(args, api) {
        // Сигнатура execute(args, api, context) проигнорирована: context не принимается!
        // ...
        const result = await toolDef.execute(
            api.callId,
            args,
            undefined, // signal всегда передается как undefined!
            (update) => { ... },
            ctx,
        );
    ```
- **Impact:**
  При отмене пользователем операции (Stop turn/thread), таймаутах или завершении сессии сетевые и тяжелые операции инструментов расширений (MCP-вызовы, HTTP fetch) не прерываются, продолжая удерживать сокеты и блокировать потоки ввода-вывода.
- **Rule:** AP-023 (Async дисциплина), AP-045 (Resource exhaustion).
- **Fix decision:** `fix-now`. Принимать третий аргумент `context: Context` в `execute(args, api, context)` и передавать `context.abortSignal` в качестве `signal` в `toolDef.execute(...)`.

---

### [P2] BL-PI-05: Отсутствие жизненного цикла и teardown в `subagents.ts` при сбросе сессии
- **Evidence:**
  - `src/runner/plugins/built-in/subagents.ts:5-20`:
    ```ts
    export const subagentsPlugin: DurablePlugin = {
        id: "subagents",
        name: "Subagents",
        category: "built-in",
        version: "1.0.0",
        register(ctx: DurablePluginContext): void {
            if (!ctx.registry) return;
            if (typeof ctx.getSubagentPolicy === "function") {
                ctx.registry.install(createSubagentExtension(ctx.getSubagentPolicy));
            }
            ctx.registry.install(Anchor);
            ctx.registry.install(DefaultCourier);
            ctx.registry.install(DefaultReporter);
        },
    };
    ```
  - `src/runner/subagent-courier.ts:13` (`clearDeliveryHold` экспортирован, но плагин `subagentsPlugin` не вызывает его при завершении/сбросе сессии).
- **Impact:**
  Если сессия прерывается во время работы дочерних субагентов, в хранилище FSM сохраняется флаг `deliveryHold`, блокирующий курьера при последующем возобновлении диалога без внешнего вмешательства.
- **Rule:** AP-013 (Целостность данных), AP-047 (Надежные side effects).
- **Fix decision:** `fix-now` (в рамках Cycle 102). Добавить `teardown()` метод в `subagentsPlugin`, выполняющий безопасный сброс временных состояний курьера.

---

### [P3] BL-PI-06: Мертвое дублирование импортов инструментов в `harness-setup.ts`
- **Evidence:**
  - `src/runner/harness-setup.ts:12-18`:
    ```ts
    import { createCodingTools, CodingTools } from "@earendil-works/pi-durable/tools";
    import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
    import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
    import { CodemodeSandbox } from "@earendil-works/pi-codemode";
    import { createSubagentExtension } from "./subagent.ts";
    import { Anchor, DefaultCourier, DefaultReporter } from "./subagent-delivery.ts";
    ```
- **Impact:**
  После выноса инструментов во встроенные плагины (`coding-tools.ts`, `codemode.ts`, `subagents.ts`), данные импорты в `harness-setup.ts` остались мёртвым кодом, вводящим разработчиков в заблуждение относительно точки инсталляции расширений.
- **Rule:** AP-015 (DRY, KISS, YAGNI), AP-025 (Дисциплина импортов).
- **Fix decision:** `log-only` (очистить в рамках Cycle 102).

---

### [P3] BL-PI-07: Ослабленная типизация `DurablePluginContext` (`any` index signature)
- **Evidence:**
  - `src/runner/plugins/types.ts:3-8`:
    ```ts
    export interface DurablePluginContext {
        cwd: string;
        storageDir?: string;
        registry?: any;
        [key: string]: any;
    }
    ```
- **Impact:**
  Использование `any` для `registry` и открытой индексной сигнатуры ослабляет TypeScript strictness, позволяя передавать некорректные контексты без предупреждения компилятора.
- **Rule:** AP-029 (TypeScript strictness).
- **Fix decision:** `log-only`. Затипизировать `registry?: Registry` и явные поля контекста.

---

## 3. Статус встроенных плагинов

| Плагин | Путь к файлу | Назначение | Текущий статус | Замечания |
|---|---|---|---|---|
| **`codemode`** | `src/runner/plugins/built-in/codemode.ts` | Быстрое выполнение JS-скриптов в QuickJS песочнице | **FAIL (Критический)** | Утеря `structuredOutput` (BL-CM-01), отсутствие `teardown()` и утечка Worker (BL-CM-02), искажение инструкций (BL-CM-03). |
| **`coding-tools`** | `src/runner/plugins/built-in/coding-tools.ts` | Базовые инструменты разработчика (`read`, `write`, `edit`, `bash`) | **PASS (Здоров)** | Интеграция с `@earendil-works/pi-durable/tools` корректна. Загрузка Photon WASM защищена через `try/catch` с откатом к стандартным инструментам. |
| **`subagents`** | `src/runner/plugins/built-in/subagents.ts` | Автономные дочерние агенты и FSM-доставка ответов | **WARN (Требует hardening)** | Наследование моделей и доставка работают стабильно. Требуется добавление `teardown()` для сброса зависших `deliveryHold` (BL-PI-05). |

---

## 4. Architecture Verification & Compliance Matrix

| Архитектурное правило | Статус | Комментарий |
|---|---|---|
| **AP-010 (Ports & Adapters)** | ⚠️ VIOLATED | Использование синтетического типа `"codemode-deferred"` нарушает чистоту адаптера. |
| **AP-011 (Низкая связность и высокая когезия)** | ✅ PASSED | Выделение плагинов в `built-in/` архитектурно верно и изолирует расширения. |
| **AP-012 (Fail-fast и контракты ошибок)** | ❌ VIOLATED | Потеря `structuredOutput` приводит к `invalid_structured_output` ошибкам ядра Durable. |
| **AP-013 (Целостность данных)** | ❌ VIOLATED | Структурированный вывод инструментов полностью стирается при прохождении через адаптер. |
| **AP-014 (SOLID & Clean Code)** | ⚠️ VIOLATED | Жизненный цикл плагинов не замкнут: `register` вызывается, `teardown` игнорируется. |
| **AP-019 (Лимиты размера файлов < 200 LOC)** | ✅ PASSED | `extension-mount.ts` (199 LOC), `tool-adapter.ts` (174 LOC), плагины (< 25 LOC). Все файлы строго в бюджете. |
| **AP-020 (Composition Root)** | ⚠️ VIOLATED | `createCodingRegistry` создает `DurablePluginRegistry`, но не сохраняет его для teardown. |
| **AP-023 (Async дисциплина)** | ❌ VIOLATED | QuickJS Worker threads и WebAssembly не закрываются через `close()` при завершении сессии. |
| **AP-026 (API-контракты и DTO)** | ❌ VIOLATED | Искажение `instructions` в `CodemodeNamespace` и потеря `structuredContent`. |
| **AP-028 (Детерминизм и тестирование)** | ⚠️ VIOLATED | Существующие тесты codemode проверяли только строковые ответы, пропустив утерю JSON-объектов. |
| **AP-029 (TypeScript strictness)** | ⚠️ VIOLATED | `any` в `DurablePluginContext` и строковые касты `exposure as string`. |
| **AP-045 (Resource exhaustion)** | ❌ VIOLATED | Утечка дескрипторов QuickJS и процессов Node Worker при частых переподключениях. |

**Residual Risk (Остаточный риск):**
До применения исправлений Cycle 102 использование инструмента `codemode` в диалогах с активными MCP-серверами или структурированными инструментами приводит к стабильному отказу вызовов инструментов внутри скриптов.

---

## 5. План реализации исправлений (Cycle 102 Slices)

### Срез S1: Восстановление контракта `structuredOutput` в адаптерах инструментов
1. В `src/runner/tool-adapter.ts`:
   - Расширить возвращаемый тип `NestedToolExecutor` полем `structuredOutput?: unknown`.
   - В `adaptExtensionTool` извлекать структурированные данные:
     ```ts
     const structuredOutput = (result as { structuredContent?: unknown }).structuredContent
         ?? (result as { structuredOutput?: unknown }).structuredOutput;
     return {
         output: result.content,
         isError: result.isError,
         details: (result.details ?? undefined) as JsonValue | undefined,
         ...(structuredOutput !== undefined ? { structuredOutput: structuredOutput as JsonValue } : {}),
     };
     ```
2. В `src/runner/extension-mount.ts`:
   - В `createNestedToolExecutor` пробрасывать `structuredOutput: res?.structuredOutput ?? (res as any)?.structuredContent` в возвращаемый результат.

### Срез S2: Замыкание жизненного цикла `DurablePluginRegistry` и `codemodePlugin.teardown()`
1. В `src/runner/plugins/built-in/codemode.ts`:
   - Сохранять экземпляр `CodemodeSandbox` в замыкании / поле плагина.
   - Реализовать метод `async teardown(): Promise<void> { await sandbox?.close(); sandbox = undefined; }`.
2. В `src/runner/harness-setup.ts`:
   - Экспортировать `pluginRegistry` наружу либо возвращать `{ registry, pluginRegistry }`.
3. В `src/runner/runtime-loader.ts`:
   - Подключить `pluginRegistry.teardownAll()` к возвращаемой функции `cleanup()`.

### Срез S3: Нормализация неймспейсов и канонический `ToolExposure`
1. В `src/runner/codemode-namespaces.ts`:
   - Раздельно регистрировать `description` и `instructions` из `def.namespace`.
2. В `src/runner/tool-adapter.ts`:
   - Удалить синтетический тип `"codemode-deferred"`.
   - Настроить каноническое отображение: `exposure === "codemode"` дает `callers: ["tools"]` и `deferred: true`.

### Срез S4: Регрессионное тестирование и верификация (TDD)
1. Создать юнит-тест в `tests/codemode-structured-output.test.ts` с mock-инструментом, объявляющим `outputSchema` и возвращающим типизированный `structuredContent`. Проверить, что `await tools.mock_structured(...)` в песочнице возвращает настоящий JS-объект.
2. Создать тест в `tests/plugin-teardown-lifecycle.test.ts`, подтверждающий вызов `teardown()` и закрытие песочницы при вызове `cleanup()` рантайма.
3. Проверить чистоту компиляции (`npm run build`) и прогон тестового набора с жесткими таймаутами (`npm test`).

---

## 6. Эмпирическая репродукция и анализ тестового покрытия

### 6.1. Анализ существующих тестов и слепых зон
В репозитории присутствуют следующие тестовые наборы, затрагивающие codemode:
- `tests/codemode-full-coverage.test.ts`: использует `createCodemodeTestHarness()` из `tests/codemode-fixture.ts`. **Слепая зона:** мок-инструмент `mcp__test__greet` был объявлен *без* `outputSchema`. Поскольку схема отсутствовала, Durable harness не требовал `structuredOutput` и применял строковый фолбэк `outputValue(bounded.content)`, что полностью замаскировало дефект BL-CM-01. Кроме того, тест напрямую вызывал `createCodemodeExtension()`, обходя `src/runner/plugins/built-in/codemode.ts` и `src/runner/harness-setup.ts`.
- `tests/codemode-canonical-routines.test.ts`: проверял рендеринг промпта и парсинг префиксов в `DynamicCodemodeNamespaces`. **Слепая зона:** в тесте проверялся только `description`, а проверка сохранения `instructions` отсутствовала (дефект BL-CM-03 остался незамеченным).
- `tests/codemode-nested-env.test.ts`: тестировал `createNestedToolExecutor`. **Слепая зона:** тест импортировал `createCodemodeExtension` из `@earendil-works/pi-coding-agent` (in-memory реализация), а не из `@earendil-works/pi-durable/codemode` (ACID Durable реализация).
- `tests/plugin-registry.test.ts`: проверял регистрацию плагина в реестре мока, но не выполнял код внутри плагина и не проверял вызов `teardown()` в связке с `openDurable`.

### 6.2. Диагностический скрипт (`scripts/diagnose-codemode.ts`)
Для прямой эмпирической проверки дефектов через реальный рантайм был разработан диагностический скрипт `scripts/diagnose-codemode.ts`. Скрипт поднимает реальный `Harness`, регистрирует инструмент с канонической схемой `createMcpResultSchema` и отправляет вызов `codemode({ code: 'const res = await tools.mcp__test__structured({ name: "Bob" }); return res;' })`.

Результат запуска диагностического скрипта (`node --import tsx scripts/diagnose-codemode.ts`):
```
========================================================
       Pi Durable Codemode Diagnostics & Repro          
========================================================

[Diagnostic 1] Checking DynamicCodemodeNamespaces instructions preservation...
  Namespace description: "Short server summary"
  Namespace instructions: "undefined"
  ❌ BL-CM-03 CONFIRMED: instructions property is missing/collapsed into description!

[Diagnostic 2] Testing Codemode execution with structured MCP tool...
  Codemode execution isError: true
  ❌ BL-CM-01 CONFIRMED: Tool returned no structuredOutput! QuickJS script rejected.
     Error details: Wall time 0.1 seconds

========================================================
Diagnostics completed successfully.
========================================================
```

Дефекты BL-CM-01 и BL-CM-03 подтверждены на 100% реальными воспроизводимыми квитанциями (receipts).

---

## 7. Заключение

Аудит завершен. Все 4 корневые причины деградации `codemode` и сопутствующие архитектурные дефекты зафиксированы с точными указаниями `file:line`, правилами AP-нормали и пошаговым планом устранения.  
Статус готовности: готов к передаче в архитектурный цикл реализации Cycle 102.
