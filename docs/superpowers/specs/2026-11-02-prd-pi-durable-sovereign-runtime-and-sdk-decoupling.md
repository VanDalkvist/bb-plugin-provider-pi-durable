# PRD & Архитектурная спецификация: Выделение суверенного рантайма Pi Durable и Plugin SDK

**Дата:** 2026-11-02  
**Статус:** APPROVED FOR IMPLEMENTATION (Архитектурное исследование завершено)  
**Область:** Декомпозиция монорепозитория `bb-plugin-provider-pi-durable` на независимый суверенный рантайм `pi-durable-runtime`, библиотеку `pi-durable-sdk`, контракты `pi-durable-contracts` и тонкий потребитель `bb-plugin-provider-pi-durable`.  
**Нормативный базис:** `/Users/vanya/Projects/arch-rules/arch-rules.md` (AP-010, AP-011, AP-012, AP-013, AP-014, AP-019, AP-020, AP-023, AP-025, AP-026, AP-029, AP-034, AP-045, AP-047).  
**Базовые первоисточники:**
- Upstream `@earendil-works/pi-durable` (v1.4.0)
- Upstream `@earendil-works/pi-codemode` (v1.0.0)
- Upstream `@earendil-works/pi-coding-agent` (v0.60.0)
- Desktop BB IDE Runtime Bundles & Source Maps (`~/Projects/bb-reference`)

---

## 1. Executive Summary & Мотивация декомпозиции

### 1.1. Контекст
В ходе Cycles 99–101 проект `bb-plugin-provider-pi-durable` эволюционировал из простого плагина в полноценный суверенный рантайм агентов с транзакционной персистентностью в SQLite (`session.sqlite`), встроенным графом задач (Task Graph / Runtime Graph), подсистемой изолированного выполнения кода в песочнице QuickJS WebAssembly (`codemode`), поддержкой многоагентного взаимодействия (нативные субагенты с курьерской доставкой) и гибкой расширяемостью через GoF Strategy плагины (`DurablePluginRegistry`).

### 1.2. Анатомия проблемы текущей архитектуры
Несмотря на чистое логическое разделение слоев по папкам (`src/runner/`, `src/contracts/`, `src/host/`), физически проект собран и распространяется как единый монолитный плагин для Beyond Boundaries (`bb-plugin-provider-pi-durable`). Это порождает три критических системных дефекта:

1. **Дефект хрупкости кэша и сборки мусора плагинов BB (The WASM Cache Prune Defect):**
   - Beyond Boundaries хранит установленные плагины в директориях по хешам коммитов: `~/.bb/plugins/cache/git/github.com/VanDalkvist/bb-plugin-provider-pi-durable/<commit-hash>/`.
   - При обновлении плагина или перезапуске BB старые коммиты вычищаются с диска.
   - Раннер Pi Durable, работающий в долгоживущем процессе, при динамическом обращении к зависимостям (например, `createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm")` в `@earendil-works/pi-codemode`) пытается разрешить путь относительно удалённой папки кэша, падает с `MODULE_NOT_FOUND` и намертво выводит из строя инструмент `codemode`.
2. **Дефект конкуренции за блокировку сессии SQLite (The Multi-Client Contention Defect):**
   - Сессия Pi Durable хранит состояние в `session.sqlite` и защищена монопольной блокировкой `session.lock` (библиотека `proper-lockfile`).
   - Когда пользователь открывает дочерний субтред (`thr_...`) или отправляет сообщение в интерфейсе BB, Beyond Boundaries вызывает команду `thread.start` и пытается породить **второй независимый процесс раннера** на ту же сессию.
   - Раннер видит, что `session.lock` занят другим живым процессом, и выбрасывает ошибку `SESSION_ALREADY_OPEN` / `SESSION_OWNER_CONFLICT`, блокируя взаимодействие с субтредом.
3. **Невозможность повторного использования рантайма вне Beyond Boundaries:**
   - Мощный ACID-рантайм агентов Pi Durable с поддержкой чекпоинтов, рекурсивных субагентов и QuickJS codemode жестко заперт внутри расширения для BB IDE.
   - Невозможно запустить этот же рантайм в терминале (standalone CLI), подключить его к Telegram-боту, веб-панели, CI/CD конвейеру или другой IDE без поднятия всего десктопного окружения BB.

### 1.3. Целевое состояние (Цель декомпозиции)
Выделить независимый репозиторий `pi-durable-runtime`, содержащий:
1. **`@pi-durable/contracts`:** Чистые Zod-схемы протокола IPC (JSON-RPC 2.0 / JSONL over stdio и Unix Domain Socket) без платформенных зависимостей.
2. **`@pi-durable/sdk`:** Легковесный SDK для авторов плагинов (`DurablePlugin`, `DurablePluginContext`, `DurablePluginRegistry`).
3. **`@pi-durable/runtime`:** Суверенное ядро исполнения, SQLite-хранилище, Task Graph, многоагентный диспетчер, CLI `pi-durable-runner` и Unix Domain Socket демон.
4. **`bb-plugin-provider-pi-durable`:** Тонкий адаптер (Consumer), отвечающий исключительно за трансляцию протокола Pi Durable в модель данных Beyond Boundaries и отображение React UI в десктопном IDE.

---

## 2. Архитектура 4 Территорий и Анализ Границ Слоёв

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                      ТЕРРИТОРИЯ 1: SOVEREIGN RUNNER CORE                        │
│                (Пакет: @pi-durable/runtime / pi-durable-core)                  │
│                                                                                 │
│   ┌───────────────────────────────┐   ┌─────────────────────────────────────┐  │
│   │        Engine & Runtime       │   │        Transactional Storage        │  │
│   │  (engine.ts, runtime.ts,      │   │  (session-storage.ts,               │  │
│   │   runtime-loader.ts)          │   │   proper-lockfile, SQLite WAL)      │  │
│   └───────────────┬───────────────┘   └──────────────────┬──────────────────┘  │
│                   │                                      │                     │
│   ┌───────────────▼───────────────┐   ┌──────────────────▼──────────────────┐  │
│   │     Task & Runtime Graph      │   │         Multi-Agent System          │  │
│   │  (runtime-graph-source.ts,    │   │  (subagent.ts, subagent-courier.ts, │  │
│   │   runtime-graph-mapper.ts)    │   │   subagent-delivery.ts)             │  │
│   └───────────────┬───────────────┘   └──────────────────┬──────────────────┘  │
│                   │                                      │                     │
│   ┌───────────────▼──────────────────────────────────────▼──────────────────┐  │
│   │                    IPC Transport Layer: Dual-Engine                     │  │
│   │  - Engine A: POSIX stdio JSON-RPC (fd0/fd1 + fd3/fd4 side-channel)      │  │
│   │  - Engine B: Unix Domain Socket Server (~/.durable/sessions/*/sock)     │  │
│   └─────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────┬─────────────────────────────┬────────────────────────┘
                           │ implements                  │ speaks
┌──────────────────────────▼───────────────┐   ┌─────────▼────────────────────────┐
│        ТЕРРИТОРИЯ 2: PLUGIN SDK          │   │  ТЕРРИТОРИЯ 3: WIRE CONTRACTS    │
│            (@pi-durable/sdk)             │   │     (@pi-durable/contracts)      │
│                                          │   │                                  │
│  - DurablePlugin / DurablePluginContext  │   │  - Zod Schemas (zero platform)   │
│  - DurablePluginRegistry (GoF Strategy)  │   │  - RunnerCommand / RunnerEvent   │
│  - Built-in: coding-tools, codemode,     │   │  - WireContext, WireMessage      │
│              subagents                   │   │  - WireLifecycle, WireTool       │
└──────────────────────────────────────────┘   └─────────▲────────────────────────┘
                                                         │ consumes over IPC
┌────────────────────────────────────────────────────────┴────────────────────────┐
│                   ТЕРРИТОРИЯ 4: HOST ADAPTER (CONSUMER)                         │
│                    (Репозиторий: bb-plugin-provider-pi-durable)                 │
│                                                                                 │
│   ┌───────────────────────────────┐   ┌─────────────────────────────────────┐  │
│   │      BB Provider Bridge       │   │          Delta Translators          │  │
│   │  (bridge.ts, bridge-router.ts,│   │  (delta-translator.ts,              │  │
│   │   runner-process.ts)          │   │   tool-delta-translator.ts)         │  │
│   └───────────────┬───────────────┘   └──────────────────┬──────────────────┘  │
│                   │                                      │                     │
│   ┌───────────────▼───────────────┐   ┌──────────────────▼──────────────────┐  │
│   │     Subthread Mirror Guard    │   │           Desktop React UI          │  │
│   │  (child-turn-guard.ts,        │   │  (src/ui/runtime-graph/*,           │  │
│   │   subthread-spawner.ts)       │   │   settings-subagent-section.tsx)    │  │
│   └───────────────────────────────┘   └─────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Доказательство 100% изоляции слоев (Zero-Leak Proof)

Аудит всех 157 файлов исходного кода репозитория подтвердил:
1. **Изоляция ядра (`src/runner/`, 54 файла):**
   - Количество импортов из `@get-bb/*`: **СТРОГО 0**.
   - Количество импортов из `src/host/`: **СТРОГО 0**.
   - Количество импортов из `src/ui/`: **СТРОГО 0**.
   - Зависимости ограничены: `@earendil-works/*`, `better-sqlite3`, `proper-lockfile`, `node:*`.
2. **Изоляция контрактов (`src/contracts/`, 9 файлов):**
   - Количество импортов из `@get-bb/*`: **СТРОГО 0**.
   - Количество импортов из `src/runner/`: **СТРОГО 0**.
   - Количество импортов из `src/host/`: **СТРОГО 0**.
   - Чистые Zod-схемы без платформенных зависимостей.
3. **Статический линтинг фаервола:**
   - Линтер `scripts/verify-layer-boundaries.mjs` проверяет AST TypeScript каждого файла и принудительно останавливает CI при попытке связать ядро с хостом.

---

## 4. Решение дефекта субтредов: Unix Domain Socket Server & Client Attachment

### 4.1. Анализ дефекта конкуренции за SQLite
Когда пользователь отправляет сообщение в субтред (`thr_j3edwc5tz9`), десктопный клиент Beyond Boundaries вызывает RPC `turn.submit`. Поскольку хост ассоциирует субтред с отдельным соединением, он пытается поднять новый раннер.
Раннер пытается заблокировать сессию через `proper-lockfile`:
```ts
// src/runner/session-storage.ts
const lock = await lockfile.lock(dir, { ... });
```
Если процесс раннера уже работает (обслуживая родительский тред), второй процесс падает с ошибкой `SESSION_ALREADY_OPEN` (ранее убивал родителя через SIGTERM, что было устранено в BL-03). В результате субтред падает с `SESSION_OWNER_CONFLICT`.

### 4.2. Архитектурный дизайн демона сессии (Session Daemon)
В целевой архитектуре `pi-durable-runtime` раннер реализует паттерн **Single-Writer Multi-Reader/Client**:

1. **Файл сокета сессии:**
   В директории сессии создается локальный сокет:
   - POSIX: `~/.durable/sessions/<sessionId>/runner.sock`
   - Windows: `\\.\pipe\durable-<sessionId>`
2. **Первичный запуск (Master Mode):**
   - Первый процесс захватывает `session.lock`, стартует IPC stdio для своего хоста И одновременно слушает сокет `runner.sock`.
3. **Вторичный запуск (Attachment Mode):**
   - Когда дочерний субтред или внешний инструмент пытается открыть ту же сессию, раннер проверяет наличие активного `runner.sock`.
   - Если сокет активен, вторичный процесс **не открывает SQLite напрямую**, а становится прозрачным мостом (прокси): перенаправляет команды `turn/start`, `steer`, `abort` с указанием конкретного `conversationId` в мастер-демон по сокету.
4. **Результат:** 100% устранение конфликтов `SESSION_OWNER_CONFLICT`, единый диспетчер задач и возможность управления сессией из любого количества терминалов и субтредов.

---

## 5. Пакетная структура независимого репозитория `pi-durable-runtime`

Репозиторий оформляется как `pnpm workspace` монорепозиторий:

```
pi-durable-runtime/
├── packages/
│   ├── contracts/             # @pi-durable/contracts (Zod схемы wire protocol)
│   │   ├── package.json
│   │   └── src/
│   │       ├── runner-command.ts
│   │       ├── runner-event.ts
│   │       ├── wire-tool.ts
│   │       └── wire-lifecycle.ts
│   │
│   ├── sdk/                   # @pi-durable/sdk (Plugin interfaces & Registry)
│   │   ├── package.json
│   │   └── src/
│   │       ├── types.ts       # DurablePlugin, DurablePluginContext
│   │       ├── registry.ts    # DurablePluginRegistry (GoF Strategy)
│   │       └── errors.ts
│   │
│   ├── plugins/               # @pi-durable/plugins (Канонические плагины)
│   │   ├── package.json
│   │   └── src/
│   │       ├── coding-tools/  # read, write, edit, bash
│   │       ├── codemode/      # QuickJS sandbox, WASI wasm asset
│   │       └── subagents/     # subagent tool, courier FSM
│   │
│   └── runtime/               # @pi-durable/runtime (Core Engine & CLI)
│       ├── package.json
│       ├── bin/
│       │   └── pi-durable.js  # Standalone CLI binary
│       └── src/
│           ├── engine.ts
│           ├── runtime.ts
│           ├── session-storage.ts
│           ├── socket-server.ts   # Unix Domain Socket IPC
│           └── index.ts       # Stdio JSON-RPC entrypoint
│
└── examples/
    ├── standalone-cli/        # Использование без IDE
    └── custom-plugin/         # Пример внешнего плагина
```

---

## 6. Детальная таблица миграции файлов исходного кода

| Текущий путь в `bb-plugin-provider-pi-durable` | Целевой пакет и путь | Назначение |
|---|---|---|
| `src/contracts/*` (9 файлов) | `@pi-durable/contracts/src/*` | Чистые DTO и Zod-схемы |
| `src/runtime-graph/schema.ts, scope.ts, types.ts` | `@pi-durable/contracts/src/runtime-graph/*` | Контракты графа задач |
| `src/runner/plugins/types.ts` | `@pi-durable/sdk/src/types.ts` | Интерфейс плагина |
| `src/runner/plugins/registry.ts` | `@pi-durable/sdk/src/registry.ts` | Реестр GoF Strategy |
| `src/runner/plugins/built-in/coding-tools.ts` | `@pi-durable/plugins/src/coding-tools.ts` | Базовые инструменты |
| `src/runner/plugins/built-in/codemode.ts` | `@pi-durable/plugins/src/codemode.ts` | Песочница QuickJS |
| `src/runner/plugins/built-in/subagents.ts` | `@pi-durable/plugins/src/subagents.ts` | Нативные субагенты |
| `src/runner/engine.ts, runtime.ts, harness-setup.ts` | `@pi-durable/runtime/src/*` | Composition Root и ядро |
| `src/runner/session-storage.ts, session-commands.ts` | `@pi-durable/runtime/src/storage/*` | SQLite транзакции |
| `src/runner/subagent-courier.ts, subagent-delivery.ts` | `@pi-durable/runtime/src/subagents/*` | FSM курьера |
| `src/host/*` (47 файлов) | Остается в `bb-plugin-provider-pi-durable` | Адаптер провайдера BB |
| `src/ui/*` (22 файла) | Остается в `bb-plugin-provider-pi-durable` | React UI расширения BB |

---

## 7. Чеклист предварительных условий перед декомпозицией (Cycle 102 Gate)

Перед физическим выделением репозитория необходимо выполнить **Hardening рантайма** в рамках текущего монорепозитория:
- [x] Локализовать дефекты подсистемы codemode и плагинов (BL-CM-01..BL-CM-04, BL-CM-08, BL-PI-05).
- [ ] Устранить утерю `structuredOutput` в `tool-adapter.ts` и `extension-mount.ts` (Slice 1).
- [ ] Замкнуть жизненный цикл `teardown()` для плагинов `codemode` и `subagents` (Slice 2).
- [ ] Раздельно регистрировать `instructions` в `DynamicCodemodeNamespaces` (Slice 3).
- [ ] Привести типы экспозиции к каноническим `deferred` / `codemode` (Slice 4).
- [ ] Пробросить `AbortSignal` в вызовы инструментов расширений (Slice 5).
- [ ] Добавить прямую зависимость `quickjs-wasi: 3.6.2` в `package.json` и настроить копирование wasm (Slice 6).
- [ ] Обобщить префикс конверта субагентов `[bb:pi-subagent-mirror:]` -> `[pi:subagent-mirror:]` (Slice 7).
- [ ] Пройти двухконтурную верификацию S9 (740+ тестов pass, 0 boundary violations).
