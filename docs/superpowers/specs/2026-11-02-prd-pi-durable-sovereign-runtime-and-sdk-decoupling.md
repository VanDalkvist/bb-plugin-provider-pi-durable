# PRD & Архитектурная спецификация: Выделение суверенного рантайма Pi Durable и Plugin SDK

**Дата:** 2026-11-02  
**Статус:** DRAFT (Архитектурное исследование завершено)  
**Область:** Декомпозиция монорепозитория `bb-plugin-provider-pi-durable` на независимый рантайм `pi-durable-runtime`, `pi-durable-sdk` и тонкий потребитель `bb-plugin-provider-pi-durable`.

---

## 1. Контекст и цели

### 1.1. Текущее состояние
В ходе Cycles 99–101 в проекте `bb-plugin-provider-pi-durable` была возведена строгая архитектурная изоляция по принципам Hexagonal Architecture (Ports & Adapters, GoF Strategy):
1. **Ядро (`src/runner/`):** Суверенный движок на базе `@earendil-works/pi-durable` (v1.4.0), управляющий транзакционным SQLite-хранилищем (`session.sqlite`), Task Graph, выполнением ходов, рекурсивными субагентами и загрузкой расширений.
2. **Контракты (`src/contracts/`):** Чистые Zod-схемы протокола IPC (JSON-RPC 2.0 / JSONL over stdio и fd3 side-channel).
3. **Плагины (`src/runner/plugins/`):** Паттерн GoF Strategy (`DurablePlugin`, `DurablePluginContext`, `DurablePluginRegistry`). Встроенные плагины: `codemode`, `coding-tools`, `subagents`.
4. **Адаптер хоста (`src/host/`):** Адаптер провайдера для Beyond Boundaries (`@get-bb/plugin-sdk`), транслирующий события раннера в дельты UI тредов (`delta-translator.ts`, `tool-delta-translator.ts`).
5. **Фаервол слоёв (`scripts/verify-layer-boundaries.mjs`):** Автоматический статический линтер на AST TypeScript, гарантирующий 0 импортов между `host` и `runner`.

### 1.2. Проблема и мотивация
Хотя код внутри репозитория разделен по директориям, физически проект упакован как единый BB-плагин. Это создает ряд критических ограничений:
1. **Зависимость от жизненного цикла плагинов BB:** При обновлении или перезагрузке плагина BB очищает директории кэша (`~/.bb/plugins/cache/git/...`), что срывает пути к нативным бинарникам/WASM (`quickjs-wasi/quickjs.wasm`), приводя к сбоям рантайма (как в инциденте с `codemode`).
2. **Конфликты монопольной блокировки SQLite:** BB пытается запускать независимые процессы раннера для дочерних субтредов (`thread.start`), которые конкурируют за файл блокировки сессии (`session.lock`), вызывая ошибки `SESSION_ALREADY_OPEN` и `SESSION_OWNER_CONFLICT`.
3. **Невозможность использования вне BB:** Движок Pi Durable с ACID-персистентностью, песочницей QuickJS и графом задач привязан к плагину BB и не может использоваться как standalone CLI-инструмент, бэкенд для Telegram-ботов, веб-серверов или интеграций с другими IDE.

### 1.3. Цель декомпозиции
Выделить суверенное ядро и SDK в независимый репозиторий `pi-durable-runtime`:
- **100% изоляция абстракций:** 0 упоминаний Beyond Boundaries, 0 зависимостей от `@get-bb/plugin-sdk`.
- **Автономный CLI и сервер:** Возможность запускать рантайм через команду `pi-durable-runner` или как Unix Domain Socket / stdio демон.
- **Открытый SDK плагинов:** Интерфейс `DurablePlugin` для подключения инструментов и расширений (включая `codemode`).
- **Тонкий BB-адаптер:** Репозиторий `bb-plugin-provider-pi-durable` становится чистым клиентом-потребителем (Consumer), зависящим от `@pi-durable/runtime` через npm или запуск внешнего процесса.

---

## 2. Архитектура 4 Территорий (The Four Territories)

```
┌────────────────────────────────────────────────────────────────────────┐
│              ТЕРРИТОРИЯ 1: SOVEREIGN RUNNER CORE                       │
│  (Пакет: @pi-durable/runtime или pi-durable-core)                     │
│  - Engine, Harness & SQLite Storage (session-storage, locking)        │
│  - TaskGraph & RuntimeGraph (source, mapper, receipts)                │
│  - Subagents multiplexer & courier                                    │
│  - Extension runner bridge & Tool adapter                             │
│  - Stdio JSON-RPC & Unix Socket Daemon Server                         │
└──────────────────┬─────────────────────────────────┬───────────────────┘
                   │ implements                      │ speaks
┌──────────────────▼─────────────┐   ┌───────────────▼───────────────────┐
│  ТЕРРИТОРИЯ 2: PLUGIN SDK      │   │  ТЕРРИТОРИЯ 3: WIRE CONTRACTS     │
│  (@pi-durable/sdk)             │   │  (@pi-durable/contracts)          │
│  - DurablePlugin interface     │   │  - JSON-RPC Command/Response      │
│  - DurablePluginContext        │   │  - RunnerEvent & WireTool schemas │
│  - DurablePluginRegistry       │   │  - WireLifecycle & WireMessage    │
│  - Built-in / External plugins │   │  - Zero runtime dependencies      │
└────────────────────────────────┘   └───────────────▲───────────────────┘
                                                     │ consumes over IPC
┌────────────────────────────────────────────────────┴───────────────────┐
│              ТЕРРИТОРИЯ 4: HOST ADAPTER (CONSUMER)                     │
│  (Репозиторий: bb-plugin-provider-pi-durable)                         │
│  - BB Provider Bridge RPC (thread/start, turn/start, thread/stop)      │
│  - Delta Translators (wire events -> BB Timeline deltas)               │
│  - Beyond Boundaries React UI (app.tsx, RuntimeGraphSegmentDetails)    │
│  - Subthread Mirror Spawner & ChildTurnGuard                           │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Доказательная база отсутствия утечек абстракций (Zero Leaks Audit)

В ходе аудита было подтверждено:
1. **Импорты пакетов:**
   - `src/runner/`: **0 импортов `@get-bb/*`**.
   - `src/contracts/`: **0 импортов `@get-bb/*`**, 0 импортов из `src/runner/` и `src/host/`.
   - `src/shared/`: **0 импортов `@get-bb/*`**.
2. **Фаервол границ:**
   - Скрипт `scripts/verify-layer-boundaries.mjs` выполняет AST-парсинг всех 166 файлов TypeScript и подтверждает строгий паритет: 0 нарушений правил `AP-020`, `AP-025`, `AP-026`.
3. **Межпроцессная граница:**
   - Хост порождает процесс раннера через `spawn(process.execPath, [runnerPath, ...])`.
   - Связь осуществляется через потоки ОС:
     * `fd 0 (stdin)`: JSON-RPC запросы хоста к раннеру.
     * `fd 1 (stdout)`: JSON-RPC ответы и события раннера хосту.
     * `fd 2 (stderr)`: Диагностические логи раннера.
     * `fd 3 (channelIn)`: Канал данных хоста.
     * `fd 4 (channelOut)`: Канал данных раннера.
   - Прямых вызовов функций в памяти Node.js между Host и Runner **не существует**.

---

## 4. Пакетная структура целевого репозитория `pi-durable-runtime`

Рекомендуется монорепозиторий на базе `pnpm` workspace:

### 4.1. Пакет `@pi-durable/contracts` (чистый контракт)
- **Назначение:** Общие схемы Zod, типы команд и событий, не зависящие от Node.js или браузера.
- **Исходники:** Перенос `src/contracts/*` и `src/runtime-graph/*`.
- **Зависимости:** `zod` (zero external platform deps).

### 4.2. Пакет `@pi-durable/sdk` (Plugin SDK)
- **Назначение:** Интерфейсы и регистраторы для авторов плагинов.
- **Исходники:**
  - `src/runner/plugins/types.ts` (`DurablePlugin`, `DurablePluginContext`)
  - `src/runner/plugins/registry.ts` (`DurablePluginRegistry`)
  - `src/shared/errors.ts`
- **Зависимости:** `@pi-durable/contracts`.

### 4.3. Пакет `@pi-durable/plugins` (набор плагинов)
- **Назначение:** Модульные плагины, подключаемые к рантайму:
  - `plugin-coding-tools`: `read`, `write`, `edit`, `bash`.
  - `plugin-codemode`: QuickJS песочница, dynamic namespaces, `quickjs-wasi`.
  - `plugin-subagents`: инструмент `subagent`, курьер, мультиплексирование дочерних бесед.
- **Зависимости:** `@pi-durable/sdk`, `@earendil-works/pi-durable`, `@earendil-works/pi-codemode`, `quickjs-wasi`.

### 4.4. Пакет `@pi-durable/runtime` (суверенное ядро и CLI)
- **Назначение:** Исполняемый демон и Composition Root:
  - `engine.ts`, `runtime.ts`, `runtime-loader.ts`.
  - `session-storage.ts`, транзакционные блокировки и чекпоинты.
  - Stdio JSON-RPC сервер (`src/runner/index.ts`).
  - Дополнительно: Unix Domain Socket сервер для устранения конфликтов блокировки субтредов.
- **CLI Binary:** `pi-durable-runner` (регистрируется в `package.json` в поле `bin`).
- **Зависимости:** `@pi-durable/contracts`, `@pi-durable/sdk`, `@pi-durable/plugins`, `@earendil-works/*`, `proper-lockfile`.

---

## 5. Архитектурное решение проблемы субтредов (Multi-Client Daemon Mode)

### 5.1. Анализ дефекта `SESSION_OWNER_CONFLICT`
Когда Beyond Boundaries открывает дочерний субтред (`thr_j3edwc5tz9` или `thr_dd66a8wtj8`), BB вызывает метод `thread.start` для каждого треда независимо.
Сейчас раннер запускается через `spawn` на каждый тред. Если субтред делит сессию с родителем (`pi_durable_...`), второй раннер падает с ошибкой `SESSION_ALREADY_OPEN`.

### 5.2. Целевое решение в новом рантайме
Раннер Pi Durable должен поддерживать **двухуровневый режим подключения**:
1. **Primary Session Owner (Master Daemon):**
   При первом запуске раннер захватывает блокировку `session.lock` и открывает локальный Unix Domain Socket:
   `~/.durable/sessions/<sessionId>/runner.sock`.
2. **Client Attachment Mode (Subthread Connection):**
   Если сокет уже существует и процесс жив, последующие команды (`turn.submit`, `prompt`, `steer`, `abort`) от дочерних тредов передаются в уже запущенный раннер по сокету с указанием целевого `conversationId`.
3. **Результат:** 1 процесс раннера на 1 сессию SQLite, 0 конфликтов блокировки, полноценная поддержка интерактивных субтредов без дублирования процессов.

---

## 6. Чеклист готовности к миграции

- [x] Полная изоляция слоёв проверена через AST (`verify-layer-boundaries.mjs`).
- [x] Отсутствие прямых импортов `@get-bb/*` в `runner`, `shared`, `contracts`.
- [x] Независимый скрипт сборки раннера через esbuild (`scripts/build-runner.mjs`).
- [x] Архитектура плагинов GoF Strategy внедрена и активна (`DurablePluginRegistry`).
- [ ] Устранение утери `structuredOutput` в `codemode` (Cycle 102).
- [ ] Добавление `quickjs-wasi` в `dependencies` и бандлинг wasm (Cycle 102).
- [ ] Обобщение префикса зеркала субагентов `[bb:pi-subagent-mirror:]` -> `[pi:subagent-mirror:]`.
- [ ] Инициализация отдельного git-репозитория `pi-durable-runtime` и публикация пакетов.
