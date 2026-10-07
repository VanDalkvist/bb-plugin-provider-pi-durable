# PRD: Архитектурное выравнивание территорий и устранение чужого владения в `bb-plugin-provider-pi-durable`

**Статус:** Draft / На согласовании (Ready for Review)  
**Дата:** 2026-10-07  
**Автор:** Lead Architect & Agent Systems Engineer  
**Целевой релиз:** v0.3.0 (Cycle 61 Arch Improvement Loop)  

---

## 1. Введение и постановка проблемы

### 1.1. Контекст
Плагин `bb-plugin-provider-pi-durable` разрабатывался как мост между Beyond Boundaries (BB IDE) и транзакционным ACID SQLite движком `@earendil-works/pi-durable`. 

### 1.2. Проблема (Диагноз независимого ревью)
В ходе независимого архитектурного аудита (сабтред `thr_vmhmq2bgra`) было выявлено фундаментальное несоответствие архитектурному контракту:
> **Плагин позиционируется как тонкий двусторонний адаптер (GoF Adapter), но внутри владеет чужими доменными территориями и содержит завендоренные куски кода, которые должны принадлежать ядру `pi-durable` или экосистеме `pi-coding-agent`.**

Вместо того чтобы быть чистой прослойкой между протоколом BB и Harness ядра Durable, плагин взял на себя:
1. **Генерацию системного промпта и правил агента (`src/runner/prompt.ts`)** — хардкод сниппетов базовых инструментов, XML-структуры правил и ручной обход `AGENTS.md` (Feature Envy по отношению к `pi-coding-agent`).
2. **Низкоуровневую реализацию сабагента (`src/runner/subagent.ts`)** — завендоренную агентскую механику рекурсивных под-сессий через транзакции Durable.
3. **Хеширование директорий сессий и lockfile-менеджмент (`src/runner/sessions.ts`)** — код управления директориями, скопированный из прототипа `experimental/durable`.
4. **Неуместную близость (Inappropriate Intimacy) в сборке расширений (`src/runner/runtime-loader.ts` + `extension-bridge.ts`)** — эмуляция внутренних контрактов `ExtensionRunner` через хаки `(api as any).output` и ручной перебор внутренних очередей провайдеров.

---

## 2. Анализ первоисточников: Что есть в Pi, а чего нет

Мы провели глубокий аудит локальных первоисточников `~/Projects/pi` (`packages/durable` и `packages/coding-agent`):

| Компонент / Функционал | Есть ли в npm пакете `@earendil-works/pi-durable`? | Есть ли в `@earendil-works/pi-coding-agent`? | Где он живет в репозитории Pi? | Вывод для нашего плагина |
|---|---|---|---|---|
| **Ядро Durable (Harness, SQLite, FSM, Storage)** | **ДА** (Harness, ToolTask, GenerationTask, CompactionTask, LiveDoc) | Нет (потребляет durable) | `packages/durable/src/` | **Переиспользуем на 100%** через публичный API пакета. |
| **Базовые инструменты разработчика (read, write, edit, bash)** | **ДА** (`@earendil-works/pi-durable/tools`) | ДА (`create*Tool`) | `packages/durable/src/tools/` | **Переиспользуем на 100%**. |
| **Промптинг, сниппеты тулов, гайдлайны** | **НЕТ** (durable агностичен к промпту, дает только `section`) | **ДА** (`create*ToolDefinition().promptSnippet`, `formatSkillsForPrompt`) | `packages/coding-agent/src/core/system-prompt.ts` | **У нас дубликат!** Нужно брать сниппеты и файлы контекста из `pi-coding-agent`, а не хардкодить в `prompt.ts`. |
| **Инструмент `Subagent`** | **НЕТ** (не экспортируется из пакета `pi-durable`) | Нет в публичном API | `packages/coding-agent/src/experimental/durable/subagent.ts` | **Осиротевший прототип.** Авторы Pi написали его в `experimental/durable/`, но не включили в пакет. У нас лежит его точная копия. |
| **Управление директориями сессий и Lockfile (`sessions.ts`)** | **НЕТ** (`pi-durable` дает только `openNodeSqliteStorage(file)`) | Нет в публичном API | `packages/coding-agent/src/experimental/durable/sessions.ts` | **Осиротевший прототип.** `pi-durable` не решает вопрос «где на диске лежат сессии проекта и как их лочить». |
| **Инструменты `codemode` и `mcp`** | **НЕТ** | **ДА** (`createCodemodeExtension`, `createMcpExtension`) | `packages/coding-agent/src/extensions/` | **Публичные фабрики Pi.** Подключаются через `DefaultResourceLoader`. |

### Ключевое открытие аудита
Причина, по которой в нашем плагине оказались `subagent.ts`, `sessions.ts` и `prompt.ts`:
> **Пакет `@earendil-works/pi-durable` является низкоуровневым вычислительным ядром (Engine), а не законченным агентом.**
> В монорепозитории Pi авторы создали директорию `packages/coding-agent/src/experimental/durable/`, где лежали прототипы клея (`sessions.ts`, `subagent.ts`, `prompt.ts`, `runtime.ts`). 
> Создатель плагина скопировал эту экспериментальную папку целиком себе в `src/runner/`.
> В результате в кодовой базе плагина **смешались 3 слоя:**
> 1. Недостающие части апстрима Pi Durable (сессии, сабагент);
> 2. Слой адаптера к экосистеме Pi (промптинг, расширения);
> 3. Собственно адаптер к Beyond Boundaries (RPC команды, трансляция дельт в чат BB).

---

## 3. Целевая архитектура (Clean Architecture & Refactoring Guru)

Мы должны чётко разграничить папки и обязанности внутри репозитория плагина по принципу **Ports and Adapters**:

```
src/
├── host/                              ◄── ТЕРРИТОРИЯ 1: BB IDE HOST ADAPTER
│   ├── bridge.ts                      (Прием JSON-RPC от BB демона)
│   ├── delta-translator.ts            (Трансляция AgentEvent -> BB turn/delta)
│   ├── tool-delta-translator.ts       (Преобразование diffs/write в виджеты BB)
│   └── runner-process.ts              (Управление дочерним процессом раннера)
│
├── runner/                            ◄── ТЕРРИТОРИЯ 4: RUNNER PROTOCOL BRIDGE
│   ├── index.ts                       (CLI точка входа --mode rpc)
│   ├── session-commands.ts            (Диспетчер команд turn/start, turn/steer)
│   ├── bridge/
│   │   └── bb-event-adapter.ts        (Трансляция FSM событий в поток WireEvent)
│   │
│   ├── adapters/                      ◄── АДАПТЕРЫ К ВНЕШНИМ СИСТЕМАМ (Экосистема Pi)
│   │   ├── extension-bridge.ts        (Адаптер Pi Extension -> Durable ToolRegistration)
│   │   └── prompt-adapter.ts          (Адаптер системного промпта через pi-coding-agent)
│   │
│   └── upstream/                      ◄── ЯВНО ВЫДЕЛЕННЫЙ СЛОЙ ШИМОВ АПСТРИМА
│       │                              (Недостающие в pi-durable утилиты, взятые из experimental)
│       ├── subagent-tool.ts           (Foreground subagent tool)
│       └── session-storage.ts         (Session directories, SQLite locking)
```

### Преимущества разделения:
1. **Никакой иллюзии, что это наш код:** слой `upstream/` изолирован и помечен как временные полифилы апстрима Pi Durable до их стабилизации в основном пакете.
2. **Устранение Feature Envy в промптинге:** `prompt-adapter.ts` перестает хардкодить текст правил и сниппетов. Он запрашивает сниппеты у фабрик тулов Pi (`createReadToolDefinition().promptSnippet` и др.) и файлы контекста у `DefaultResourceLoader.getAgentsFiles()`.
3. **Чистые границы DTO:** мост между BB и Durable не содержит размазанной логики сборки промптов.

---

## 4. План изменений по шагам (Refactoring Slices)

### Срез 1: Декуплинг системного промпта (`prompt.ts` -> `prompt-adapter.ts`)
- **Проблема:** Хардкод правил `<rules>`, сниппетов тулов и ручной обход `AGENTS.md`.
- **Решение:**
  - Получать сниппеты и гайдлайны инструментов динамически из фабрик `@earendil-works/pi-coding-agent` (`createReadToolDefinition`, `createWriteToolDefinition`, `createEditToolDefinition`, `createBashToolDefinition`).
  - Получать проектные файлы контекста через `resourceLoader.getAgentsFiles()`.
  - Получать навыки через `resourceLoader.getSkills()`.
  - Устранить 120 строк захардкоженного текста правил.

### Срез 2: Изоляция и типизация `extension-bridge.ts`
- **Проблема:** Неуместная близость с `ExtensionRunner`, касты `(api as any).output`, захардкоженные заглушки.
- **Решение:**
  - Создать формальный типизированный класс `PiExtensionBridge`.
  - Оформить контракт обратного вызова для стриминга вывода тулов без кастов `any`.
  - Обеспечить строгую передачу контекста `createToolContext` и снимка `getCallableTools`.

### Срез 3: Выделение `upstream/` (Карантин чужого кода)
- **Проблема:** `subagent.ts` и `sessions.ts` лежат в корне раннера так, будто это специфика BB плагина.
- **Решение:**
  - Перенести `subagent.ts` и `sessions.ts` в `src/runner/upstream/`.
  - Добавить исчерпывающую документацию происхождения (provenance): ссылка на `packages/coding-agent/src/experimental/durable/` и причины отсутствия в `@earendil-works/pi-durable`.
  - Оформить их как чистые плагины расширения ядра Durable.

### Срез 4: Декомпозиция God-метода `loadHarnessEnvironment`
- **Проблема:** 180 строк сборки всех подсистем в одном файле `runtime-loader.ts`.
- **Решение:**
  - Разделить на 3 детерминированные фазы (AP-020):
    1. `resolveRuntimeSettings(location)` — чтение конфигов и прокси.
    2. `initializeExtensionEnvironment(...)` — запуск расширений, MCP и регистрация моделей.
    3. `mountHarness(...)` — открытие SQLite и монтирование реестра Durable.

---

## 5. Аудит требований к установке (Requirements Audit)

По тем же принципам Clean Architecture устраняем путаницу в требованиях:

### Что обязан предоставить пользователь:
1. **BB IDE >= 0.45**
2. **Node.js >= 22.19** (для встроенного в Node движка `node:sqlite`)
3. **Авторизованный CLI `pi`** (хотя бы один вход через `pi` / `/login` для сохранения ключей в `~/.pi/agent/auth.json`)
4. **Конфигурации по желанию:** `~/.pi/agent/settings.json`, `~/.pi/agent/mcp.json`.

### Что предоставляет плагин (всё остальное "из коробки"):
- Встроенный самодостаточный раннер с зависимостями `@earendil-works/pi-durable` и `@earendil-works/pi-coding-agent`.
- **Никаких `npm install -g @earendil-works/pi-durable`!** Требование глобальной установки пакета устранено как устаревший артефакт.
- Автоматический поиск сессий и SQLite хранилище в `~/.bb/pi-bridge-sessions/`.

---

## 6. Метрики успеха и верификация

1. **AP-010 / AP-018 Compliance:** Ни один файл плагина не содержит захардкоженных текстов инструкций и сниппетов тулов Pi.
2. **AP-019 Compliance:** Все модули строго < 200 строк (с запасом от лимита 250).
3. **AP-029 Strict TypeScript:** 0 использований `as any` в `src/runner/extension-bridge.ts`.
4. **Тесты:** 100% сохранение зелёного статуса тест-сьюта (47+ тестов).
5. **Live Verification:** Успешный запуск сабтреда в BB IDE с подтверждением работы `read`, `bash`, `codemode` и `mcp__*`.
