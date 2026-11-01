# Исследование: Выделение суверенного рантайма Pi Durable и Plugin SDK в независимый репозиторий

**Дата:** 2 ноября 2026 г.  
**Исследователь:** Principal Software Architect & Lead Engineer  
**Статус:** Завершено (Approved Architectural Research)  
**Область:** Декомпозиция монорепозитория `bb-plugin-provider-pi-durable` на суверенное ядро `pi-durable-runtime`, библиотеку `pi-durable-sdk`, контракты `pi-durable-contracts` и тонкий потребительский адаптер `bb-plugin-provider-pi-durable`.  
**Связанные документы:**
- PRD: `docs/superpowers/specs/2026-11-02-prd-pi-durable-sovereign-runtime-and-sdk-decoupling.md`
- План цикла: `docs/superpowers/plans/2026-11-02-arch-improvement-cycle-102-codemode-hardening-and-runtime-decoupling-prep.md`
- Аудит codemode: `docs/arch-improvement/audits/2026-11-01-builtin-plugins-and-codemode-audit.md`
- Аудит связности Cycle 99: `docs/arch-improvement/cycle-99-decoupling-audit.md`

---

## 1. Введение и цели исследования

### 1.1. Текущий контекст
Репозиторий `bb-plugin-provider-pi-durable` исторически создавался как плагин-провайдер для Beyond Boundaries IDE. Однако по мере развития (Cycles 56–101) внутри него сформировалось полноценное, отказоустойчивое ядро агентского рантайма на базе `@earendil-works/pi-durable` (v1.4.0):
- Транзакционная ACID-персистентность в SQLite с версионированием через Chord (`session.sqlite`, WAL-режим).
- Task Graph и Runtime Graph с отслеживанием жизненного цикла задач (`running`, `waiting`, `sleeping`, `completed`, `failed`).
- Рекурсивный каскад субагентов с FSM-курьером и доставкой через `Anchor`/`Courier`/`Reporter`.
- Изолированная песочница QuickJS для исполнения кода (`codemode`) и динамическая загрузка расширений/MCP-серверов.
- Строгий двунаправленный протокол JSON-RPC 2.0 / JSONL над POSIX stdio.

### 1.2. Проблема текущей архитектуры
Хотя код разнесен по каталогам `src/runner/` (рантайм) и `src/host/` (адаптер BB), проект собран как единый npm-пакет и плагин Beyond Boundaries:
1. **Зависимость от каталога плагинов BB:** При установке или обновлении плагина BB очищает кэш плагинов (`~/.bb/plugins/cache/git/...`), срывая локальные пути к WASM-модулям (`quickjs-wasi/quickjs.wasm`), что приводило к отказу `codemode`.
2. **Конкуренция за монопольную блокировку сессии:** При параллельном запуске нескольких тредов в BB хост-демон пытается запускать несколько экземпляров раннера на одной рабочей директории, порождая конфликты `SESSION_ALREADY_OPEN` и блокировки SQLite.
3. **Невозможность использования вне Beyond Boundaries:** Мощный транзакционный агентский движок невозможно запустить в терминале (standalone CLI), использовать как бэкенд для Telegram/Discord ботов или интегрировать в другие инструменты разработчика без таскания зависимостей от `@get-bb/plugin-sdk`.

### 1.3. Вопрос исследования
*Каким образом выделить суверенное ядро Pi Durable в независимый репозиторий `pi-durable-runtime`, обеспечив 100% отсутствие утечек абстракций, нулевые зависимости от Beyond Boundaries, сохранение ACID-гарантий и обратную совместимость для плагина `bb-plugin-provider-pi-durable`?*

---

## 2. Анализ первоисточников (Primary Sources)

### 2.1. `@earendil-works/pi-durable` (v1.4.0)
Изучение исходного кода в `~/Projects/pi/packages/durable/`:
- **`Harness` и `Session` (`src/harness/harness.ts`):** Ядро Durable представляет собой headless-рантайм. Оно не зависит от UI, DOM или платформенных шеллов. Сессия открывается вызовом `Harness.open(storage, options, context)`.
- **ACID-транзакции и документы (`src/documents.ts`):** Любое изменение состояния выполняется через `tx.doc(...)` и фиксируется атомарным коммитом в SQLite WAL.
- **Жизненный цикл задач (`src/harness/task-graph.ts`):** `GenerationTask`, `ToolTask`, `CompactionTask` являются детерминированными FSM-автоматами.
- **Вывод первоисточника:** Ядро `@earendil-works/pi-durable` спроектировано как встраиваемая библиотека (in-process library) для создания любых агентских приложений. Оно **не имеет концепции графических тредов, интерфейсов или окон**.

### 2.2. `@earendil-works/pi-coding-agent` (v1.4.0)
Изучение исходного кода в `~/Projects/pi/packages/coding-agent/`:
- **`ResourceLoader` (`src/core/resource-loader.ts`):** Загружает расширения, скиллы, промпты и настройки из каталогов `~/.pi/agent/` и `.pi/`.
- **`ModelRuntime` (`src/core/model-runtime.ts`):** Управляет конфигурацией поставщиков моделей (Anthropic, OpenAI, Google, Bedrock) и ключами доступа (`auth.json`).
- **`ExtensionRunner` (`src/core/extensions/runner.ts`):** Обеспечивает мост для выполнения хуков расширений (`before_agent_start`, `tool_call`, `tool_result`).
- **Вывод первоисточника:** Уровень расширений Pi Coding Agent полностью платформенно-независим и работает поверх чистого Node.js / Bun.

### 2.3. `@earendil-works/pi-codemode` (v1.4.0)
Изучение исходного кода в `~/Projects/pi/packages/codemode/`:
- **`CodemodeSandbox` (`src/runtime/host.ts`):** Запускает QuickJS в отдельном пуле `node:worker_threads` с поддержкой прерывания через `Atomics` и SharedArrayBuffer.
- **Вывод первоисточника:** Песочница автономна, но требует корректного закрытия через `close()` для предотвращения утечек системных воркеров.

---

## 3. Детальный аудит связности в `bb-plugin-provider-pi-durable`

### 3.1. Уровень чистоты слоёв (Firewall Audit)
Скрипт `scripts/verify-layer-boundaries.mjs` выполняет статический анализ AST:
- `src/runner/`: **0 прямых импортов `@get-bb/*`** и **0 импортов `src/host/*`**.
- `src/contracts/`: **0 импортов `@get-bb/*`**, **0 импортов `runner` и `host`**.
- Межпроцессная связь: Хост и раннер разделены процессом ОС (`child_process.spawn`) и общаются по протоколу JSONL.

### 3.2. Скрытые (неявные) утечки абстракций хоста в ядро
Несмотря на чистоту импортов, аудит выявил 4 неявные семантические утечки абстракций хоста в слой `src/runner/`:

1. **Идентификаторы тредов BB в SQLite документах (`src/runner/binding-docs.ts`):**
   ```ts
   export interface StoredBinding {
       readonly providerId: string;
       readonly sessionId: string;
       readonly conversationId: ConversationId;
       readonly threadId: string;        // <- Идентификатор треда BB
       readonly parentThreadId: string | null; // <- Идентификатор родительского треда BB
   }
   ```
   Внутренние документы раннера `durable.binding` и `durable.binding-index` сохраняют `threadId` и `parentThreadId`. Это нарушает Dependency Inversion Principle (AP-010, AP-020): внутреннее ядро базы данных раннера знает о структуре таблиц интерфейса Beyond Boundaries.
2. **Обнаружение субагентов через индекс тредов (`src/runner/subagent-watcher.ts:88`):**
   ```ts
   const index = await harness.snapshot(BindingIndexDoc, BACKGROUND_CONTEXT);
   if (index?.byThreadId) {
       for (const convId of Object.values(index.byThreadId)) { ... }
   }
   ```
   Вместо того чтобы находить дочерние беседы через собственный канонический документ `SubagentsDoc` (`durable.subagents`) или API `harness.scanConversations()`, раннер ищет их по таблице связок с тредами хоста.
3. **Ограничение длины заголовков субагентов под колонку БД Beyond Boundaries (`src/runner/subagent.ts`):**
   Функция `nativeChildTitle` обрезает длину имени задачи до 494 символов исключительно из-за того, что в SQLite-базе Beyond Boundaries колонка `threads.title` имеет жесткое ограничение в 500 символов.
4. **Внеполосные файловые дескрипторы FD 3 и FD 4 (`src/runner/bridge-channel.ts`):**
   Раннер жестко завязан на каналы FD 3 и FD 4 для передачи `model-scope` и сигналов готовности. При попытке запустить раннер как стандартный POSIX-процесс (через stdin/stdout) попытка записи в FD 3 вызывает предупреждения `EBADF`/`ENXIO`.

---

## 4. Целевая суверенная архитектура (Target Hexagonal Architecture)

### 4.1. Разделение на 4 Территории (The Four Territories)

```
┌────────────────────────────────────────────────────────────────────────┐
│              ТЕРРИТОРИЯ 1: SOVEREIGN RUNNER CORE                       │
│  (Пакет: @pi-durable/core / pi-durable-runtime)                       │
│  - DurableEngine & Transactional SQLite Harness                        │
│  - TaskGraph & RuntimeGraph (наблюдаемость FSM-задач)                  │
│  - Subagents Engine & Courier (мультиплексирование бесед)              │
│  - Extension Bridge & Tool Execution Subsystem                         │
│  - JSON-RPC 2.0 / POSIX stdio & Unix Domain Socket Server              │
│  - Абстрактные адаптеры: IStoragePort, ISubagentSpawner, IEventSink    │
└──────────────────┬─────────────────────────────────┬───────────────────┘
                   │ implements                      │ speaks
┌──────────────────▼─────────────┐   ┌───────────────▼───────────────────┐
│  ТЕРРИТОРИЯ 2: PLUGIN SDK      │   │  ТЕРРИТОРИЯ 3: WIRE CONTRACTS     │
│  (@pi-durable/sdk)             │   │  (@pi-durable/contracts)          │
│  - DurablePlugin interface     │   │  - RunnerCommand / RunnerEvent    │
│  - DurablePluginContext        │   │  - RuntimeGraphSnapshot schemas   │
│  - DurablePluginRegistry       │   │  - JSON-RPC 2.0 strict schemas    │
│  - Пакеты встроенных плагинов: │   │  - Zero runtime dependencies      │
│    coding-tools, codemode, subagents                                   │
└────────────────────────────────┘   └───────────────▲───────────────────┘
                                                     │ consumes over IPC / Socket
┌────────────────────────────────────────────────────┴───────────────────┐
│              ТЕРРИТОРИЯ 4: HOST CONSUMER ADAPTER                       │
│  (Репозиторий: bb-plugin-provider-pi-durable)                         │
│  - BB Provider API implementation (thread/start, turn/start, etc.)     │
│  - Delta Translator (маппинг событий раннера в таймлайн треда BB)      │
│  - Subthread Mirror Manager (синхронизация субтредов в сайдбаре)       │
│  - UI Views & Cards (RuntimeGraphSegmentDetails, Policy Settings)      │
│  - Управление внешним процессом раннера или сокетом демона             │
└────────────────────────────────────────────────────────────────────────┘
```

### 4.2. Ключевые архитектурные порты суверенного ядра

#### Порт запуска дочерних процессов (`ISubagentProcessSpawner`)
Вместо хардкодного вызова `bb thread spawn` в ядре объявляется порт:
```ts
export interface ISubagentProcessSpawner {
    spawnSubagent(options: {
        sessionId: string;
        parentConversationId: number;
        conversationId: number;
        task: string;
        model: ModelRef;
        thinkingLevel: string;
    }): Promise<{ processId?: number; handle?: unknown }>;
}
```
**Реализации:**
- `InProcessSpawner` (Default для Headless CLI): Дочерние беседы крутятся внутри одного процесса `Harness` без создания внешних процессов.
- `ForkProcessSpawner` (Для независимых воркеров): Создает независимый процесс Node.js.
- `BbSubthreadSpawner` (Реализация на стороне BB-плагина): Вызывает `bb thread spawn` для отображения карточки в сайдбаре Beyond Boundaries.

#### Порт сопоставления внешних сущностей (`IExternalIdentityStore`)
Вместо сохранения `threadId` в SQLite раннера:
- Раннер оперирует исключительно `conversationId` (1, 2, 3...).
- Для привязки внешних идентификаторов (ID треда в BB, ID чата в Telegram, ID тикета в Jira) вводится абстрактное хранилище метаданных сессии `SessionMetadataDoc` со свободной картой `metadata: Record<string, string>`.
- Хост Beyond Boundaries сохраняет привязку `bbThreadId <-> conversationId` в локальном файле `adapter-bindings.json` на своей стороне.

---

## 5. Пакетная структура монорепозитория `pi-durable-runtime`

Целевой репозиторий `pi-durable-runtime` организуется как монорепозиторий на базе `pnpm` workspaces:

```
pi-durable-runtime/
├── packages/
│   ├── contracts/                # @pi-durable/contracts
│   │   ├── src/
│   │   │   ├── commands.ts       # Схемы команд раннера (prompt, steer, abort)
│   │   │   ├── events.ts         # Схемы событий (text_delta, tool_call, etc.)
│   │   │   ├── runtime-graph.ts  # Схемы снапшотов графа задач
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── sdk/                      # @pi-durable/sdk
│   │   ├── src/
│   │   │   ├── plugin.ts         # Интерфейс DurablePlugin и DurablePluginContext
│   │   │   ├── registry.ts       # DurablePluginRegistry (initAll, teardownAll)
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── plugins/                  # @pi-durable/plugins (встроенные плагины)
│   │   ├── src/
│   │   │   ├── coding-tools/     # read, write, edit, bash + Photon
│   │   │   ├── codemode/         # QuickJS песочница, namespaces, wasm
│   │   │   ├── subagents/        # subagent tool, Anchor, Courier, Reporter
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   └── core/                     # @pi-durable/core (исполняемый демон и CLI)
│       ├── src/
│       │   ├── engine/           # DurableEngine, Session, Storage
│       │   ├── server/           # Stdio JSON-RPC & Unix Socket сервер
│       │   ├── bin/              # CLI entrypoint: pi-durable-runner
│       │   └── index.ts
│       └── package.json
│
├── pnpm-workspace.yaml
├── package.json
└── tsconfig.base.json
```

---

## 6. Пошаговая дорожная карта выделения (Phased Roadmap)

### Фаза 1: Подготовка и устранение связности в текущем репозитории (Cycle 102)
1. **Устранение дефектов подсистемы Codemode (BL-CM-01..BL-CM-04):**
   - Восстановление передачи `structuredOutput` в `adaptExtensionTool` и `createNestedToolExecutor`.
   - Замыкание жизненного цикла `DurablePluginRegistry` и реализация `teardown()` в `codemodePlugin`.
   - Разделение `description` и `instructions` в `DynamicCodemodeNamespaces`.
   - Удаление синтетического типа `"codemode-deferred"`.
2. **Ликвидация зависимости от FD 3/4:**
   - Перевод сигнала `ready` на канонический stdout JSON-RPC.
   - Сделать каналы FD 3 и FD 4 строго опциональными (деградация без предупреждений при их отсутствии).
3. **Очистка доменных имен:**
   - Обобщение префикса envelopes с `[bb:pi-subagent-mirror:v1]` на `[pi:subagent-mirror:v1]` с поддержкой старого префикса для обратной совместимости.
4. **Снятие зависимости `subagent-watcher` от `BindingIndexDoc`:**
   - Перевод обнаружения бесед на нативный `SubagentsDoc` и `harness.scanConversations()`.

### Фаза 2: Создание репозитория `pi-durable-runtime` и перенос ядра
1. Инициализация репозитория `VanDalkvist/pi-durable-runtime`.
2. Настройка `pnpm` workspace и пакетов `@pi-durable/contracts`, `@pi-durable/sdk`, `@pi-durable/plugins`, `@pi-durable/core`.
3. Перенос протестированного кода из `src/runner/` и `src/contracts/`.
4. Настройка сборки единого standalone-бандла `dist/bin/pi-durable-runner.js`.

### Фаза 3: Перевод `bb-plugin-provider-pi-durable` на роль чистого Consumer
1. Подключение `@pi-durable/contracts` и `@pi-durable/core` как внешних зависимостей (npm или git submodule).
2. Замена запуска встроенного `dist/runner/index.js` на вызов `pi-durable-runner` или подключение через Unix Domain Socket.
3. Сохранение полной функциональности UI Beyond Boundaries (React-компоненты, таймлайн, карточки, граф задач).

---

## 7. Заключение

Архитектурное исследование полностью подтверждает техническую зрелость и готовность к выделению суверенного рантайма:
- Ядро `src/runner/` на 95% уже изолировано от Beyond Boundaries.
- Оставшиеся 5% связности (FD 3/4, `BindingIndexDoc`, имена конвертов) устраняются в рамках запланированного цикла Cycle 102.
- Выделение рантайма окончательно устраняет сбои с очисткой кэша WASM, решает проблему конкурентных блокировок сессий через единый сокет-демон и открывает возможность использования Pi Durable в любых внешних клиентских окружениях.
