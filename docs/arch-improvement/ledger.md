
### Non-Blocking Background Subagents & Turn Watchdog Prevention (Cycle 79) — 2026-10-27 (Execution Receipt)
- **Цель и статус:** Устранение блокировки родительской беседы при работе фоновых субагентов (P1-SUB1) и предотвращение ложного срабатывания сторожевого таймера 120s в BB Core (P1-WD1). Статус: **PASS (VERIFIED)**.
- **Устранённые дефекты и первоисточники:**
  1. *[P1-SUB1: Разблокировка родителя через канонический Anchor]:*
     - Первоисточник: спецификация Pi Durable §5.5 (Rule 4) и канонический пример `packages/durable/test/examples/23-subagent-background.ts`.
     - Коренная причина: `src/runner/subagent.ts` создавал дочернюю беседу с `ownership: { kind: "task", taskId: api.taskId }`, назначая владельцем синхронный вызов инструмента `pi.tool`. Из-за этого планировщик Pi Durable удерживал инструмент в статусе `completing` на всё время работы субагента, а родительская генерация стояла в `waiting`, блокируя родительскую беседу.
     - Решение: при `isBackground: true` дочерняя беседа создаётся под фоновым анкером `tx.createTask(Anchor, null, BACKGROUND)`. Инструмент `api.taskId` завершается за 50 мс (`terminal`), родительская беседа становится `idle`, может сразу отвечать пользователю и запускать параллельных субагентов.
  2. *[P1-WD1: Снятие сторожевого таймера 120s в BB Core]:*
     - Первоисточник: исходники BB Core (`daemon-bundle.mjs`, таймер `turnStartWatchdog = 120s`, множество `p`).
     - Коренная причина: `handleTurnStart` в `src/host/bridge-router.ts` на корневом треде отправлял только `input.accepted`, но не отправлял `turn.open`, ожидая `turn_start` от раннера.
     - Решение: отправка `{ kind: "turn.open" }` сразу при приёме ввода в `handleTurnStart` (по образцу `provider-claude-code` и собственной реализации для child threads). Это сразу очищает `p` в BB Core и снимает таймер.
  3. *[P2-UI1: Логическая иерархия дерева задач UI]:*
     - В `RuntimeGraphConversations` добавлен метод `recordLogicalOwner`.
     - `RuntimeGraphSource` извлекает `ownerTaskId` из `SubagentsDoc` и связывает дочернюю беседу с вызывающим инструментом `subagent: ...`, сохраняя аккуратную иерархию в UI Task Tree.
- **TDD и доказательная база:**
  - `tests/turn-start-watchdog-prevention.test.ts`: 46 строк (< 200). RED: подтверждён провал без `turn.open`; GREEN: подтверждена немедленная отправка `turn.open` на корневом треде.
  - `tests/subagent-background-unblock.test.ts`: 113 строк (< 200). RED: подтверждено отсутствие `Anchor`; GREEN: подтверждено создание под `Anchor` (`background: true`) и сохранение прямого владения для foreground-режима.
  - Общий сьют: **530 тестов бэкенда: 530 pass, 0 fail**.
  - Контракты: `npm run test:contracts` (Negative contract guard: TS2322 rejection, pass).
  - Типизация: `npx tsc --noEmit` (0 errors).
- **Line Budgets (AP-019):**
  - `src/runner/subagent.ts`: 184 строки (< 200)
  - `src/host/bridge-router.ts`: 186 строк (< 200)
  - `src/runner/runtime-graph-conversations.ts`: 52 строки (< 200)
  - `src/runner/runtime-graph-source.ts`: 197 строк (< 200)
  - `tests/turn-start-watchdog-prevention.test.ts`: 46 строк (< 200)
  - `tests/subagent-background-unblock.test.ts`: 113 строк (< 200)
- **Сборка (Build Receipt):**
  - Бандлы пересобраны: `npm run build` успешно собрал `dist/runner/index.js`, `dist/host.js`, `dist/server.js`.
  - Версия обновлена до **0.3.2**.

### Truthful Live Graph Metadata & Sanitized Attributes (Cycle 80) — 2026-10-27 (Execution Receipt)
- **Цель и статус:** Устранение 4 подтверждённых первопричин исчезновения и обезличивания активных/быстрых задач в Runtime Task Graph (`runtime-graph-live-truth-investigation.md`). Статус: **PASS (VERIFIED)**.
- **Устранённые дефекты и архитектурные решения:**
  1. *[Сохранение имён быстрых инструментов в terminal receipts]:*
     - При завершении задач до истечения 250 мс дебаунса `subscribeCommits` в `RuntimeGraphSource` вызывает `recordTerminalWithDetails(receipts, taskVal, names, nativeStartedAt)`.
     - `TaskNames` хранит структурированные `TaskCallDetails` (`toolName`, `targetHint`, `preview`).
     - В `RuntimeTaskReceipt` заносятся реальные `toolName`, `targetHint`, `preview`, `startedAt`, `durationMs` вместо анонимного fallback `pi.tool #id`.
  2. *[Безопасная санитизация targetHint]:*
     - Функция `sanitizeTargetHint` в `task-labels.ts` фильтрует только разрешённые строковые ключи (`command`, `path`, `pattern`, `query` и др.) и выполняет детерминированную санитизацию: удаляет Bearer токены, `ghp_` токены, API ключи, пароли и секреты, предотвращая утечку sensitive data в снимки графа. Длина строго ограничена <= 128 символов.
  3. *[Передача реальных метаданных generation]:*
     - В `runtime-graph-mapper.ts` реализована функция `extractTaskModelMeta`, извлекающая точную модель (`model: { provider, modelId }`) и `thinkingLevel` из чекпоинта `GenerationTask` (фаза `request`) либо из `pi.agent` doc (для root) / `bb.subagents` doc (для child). Исключены любые глобальные дефолты или догадки.
     - Для задачи генерации формируется информативная подпись: `assistant turn · ${modelId} (${thinkingLevel})`.
  4. *[Настоящее время старта и длительность]:*
     - Точное время `TaskRecord.startedAt` фиксируется в `nativeStartedAt` на момент коммита задачи. Проспективное время наблюдения НЕ называется `startedAt`. Для активных задач вычисляется `durationMs = clock() - startedAt`.
  5. *[Связывание логического владения субагентами]:*
     - `recordSubagentOwnership` считывает `ownerTaskId` из `bb.subagents` и связывает дочерние беседы с вызвавшим инструментом родителя в `RuntimeGraphConversations.recordLogicalOwner`.
- **TDD и доказательная база:**
  - `tests/runtime-graph-live-metadata.test.ts`: 159 строк (< 200 LOC), 8 тестов, 100% pass:
    * Приёмка санитизированных полей `toolName`, `targetHint`, `model`, `thinkingLevel`, `startedAt` Zod-схемами.
    * Отклонение оверлоад-полей (>64/128/32 символов).
    * Санитизация Bearer, ghp и api_key токенов.
    * Обучение `TaskNames` структурированным именам из `pi.live` и transcript.
    * Сохранение имени и превью при завершении задачи за 5 мс до дебаунса.
    * Извлечение реальной модели и thinkingLevel для узла генерации.
    * Логическое связывание бесед субагента по `ownerTaskId`.
  - Все 63 теста runtime graph: **63 pass, 0 fail**.
  - Контракты: `npm run test:contracts` (Negative contract guard: TS2322 rejection pass).
  - Строгая типизация: `npx tsc --noEmit` (0 errors).
- **Line Budgets (AP-019):**
  - `src/runtime-graph/types.ts`: 138 строк (< 200)
  - `src/runtime-graph/schema.ts`: 169 строк (< 200)
  - `src/runner/task-labels.ts`: 106 строк (< 200)
  - `src/runner/runtime-graph-mapper.ts`: 186 строк (< 200)
  - `src/runner/runtime-graph-receipts.ts`: 154 строки (< 200)
  - `src/runner/runtime-graph-conversations.ts`: 52 строки (< 200)
  - `src/runner/runtime-graph-source.ts`: 180 строк (< 200)
  - `tests/runtime-graph-live-metadata.test.ts`: 159 строк (< 200)
- **Файловый артефакт:** `/Users/vanya/.bb/thread-storage/thr_ct3kk9xne6/runtime-graph-live-metadata-fix-result.md`.

### Candidate Checkpoint 0.3.4 (Cycle 79 Integration & Dist Reconciliation) — 2026-10-27 (Execution Receipt)
- **Цель и статус:** Интеграция и фиксация незакоммиченного кандидата Cycle 79 (канонический паттерн фоновых субагентов `Anchor` по Pi Durable Spec §5.5 Rule 4, снятие сторожевого таймера 120s `turn.open` в `handleTurnStart`), синхронизация `dist/` бандлов, микробэмп `0.3.3` -> `0.3.4`. Статус: **CHECKPOINT COMMITTED & PUSHED (Architecture and Live Review gates remain OPEN; NOT final PASS)**.
- **Основание и прямое разрешение:** Прямое поручение Вани («Если есть незакоммиченные версии файлов – делай новый микро бамп, коммить и пушь»). Снятие гейта публичного репозитория для сохранения целостного рабочего снимка. Handoff ownership подтверждён автором `thr_t3x53wmjif`.
- **Реальные выполненные изменения:**
  1. `src/runner/subagent.ts`: канонический `Anchor` task (`{ ownership: { kind: "conversation" }, background: true }`) для фоновых субагентов, освобождающий инструмент `api.taskId` в `terminal` и возвращающий родительскую беседу в `idle`.
  2. `src/runner/subagent-docs.ts`: фиксация `anchorTaskId` в `SubagentRecord`.
  3. `src/host/bridge-router.ts`: отправка `{ kind: "turn.open" }` сразу при приёме ввода в `handleTurnStart` на корневом треде для разоружения 120s watchdog таймера в BB Core.
  4. `tests/subagent-background-unblock.test.ts` & `tests/turn-start-watchdog-prevention.test.ts`: TDD тесты на паттерн Anchor и watchdog-предотвращение.
  5. `package.json`, `package-lock.json`, `CHANGELOG.md`: версия обновлена `0.3.3` -> `0.3.4`.
  6. Пересобраны production-бандлы `dist/` из точного исходного кода.
- **TDD и доказательная база:**
  - Полный тестовый сьют (`npm test`): 582 теста (539 backend + 43 UI), 100% pass, 0 fail.
  - Contract compiler & negative guard (`npm run test:contracts`): PASS.
  - Строгая типизация (`npx tsc --noEmit`): 0 errors.
  - Import AST SCC (алгоритм Тарьяна): 135 файлов, 0 циклов.
  - Line budgets (AP-019): все файлы строго < 200 LOC.
- **Статус ревью, рантайма и открытых дефектов:**
  - Архитектурное и независимое live review (thr_qf7vysbvrr): **OPEN**.
  - Realtime stale graph bug & UI active-first / "See more" compact history / native BB chrome: **RESOLVED in Cycle 82** (Task Graph breadcrumbs and root-only history folding).
  - Runtime resident state: плагин на диске обновлён до 0.3.13, но работающие сессии BB удерживают загруженный процесс (`restart: pending`, `runtime verified: unverified (not switched)`).

### Subagent Active Status, Enriched Naming & Fixed Details Layout (Cycle 83) — 2026-10-28 (Execution Receipt)
- **Цель и статус:** Устранение ложного статуса «Completed 1ms» для фоновых субагентов во время их работы, обогащение названий анкеров читаемыми именами субагентов с сохранением технических префиксов, отображение задачи субагента в инспекторе, стабилизация высоты контейнера сегмента и фиксация шапки Details. Статус: **PASS (VERIFIED)**.
- **Устранённые дефекты и архитектурные решения:**
  1. *[Честный статус активности родителя (Bubble-up Active State)]:*
     - Первоисточник: задача `Anchor` (`bb.subagent-anchor`) завершалась за 1 мс, чтобы отпустить родительскую беседу. Из-за этого `node-row.tsx` смотрел только на собственный `receipt.outcome === "completed"` и выводил зелёную галочку `✓` и `1ms`, хотя дочерняя беседа субагента вовсю работала.
     - Решение: в `resolveStatusIcon(item)` добавлена проверка `hasActiveWork(item)`. Если у задачи есть активные потомки, она отображает синюю иконку работы `▷ Play` (`text-blue-500`) и статус `Running (active child work)`. Длительность вычисляет живое время работы (`liveElapsed = now - startedAt`), тикающее в реальном времени. Зелёная галочка загорается строго после завершения всех дочерних задач.
  2. *[Обогащение названий анкеров и сохранение префиксов]:*
     - Функция `findSubagentMeta` в `runtime-graph-mapper.ts` извлекает `name` и `task` из `SubagentsDoc` по `anchorTaskId`.
     - Узел анкера в графе именуется как `bb.subagent-anchor · subagent: ${name}`, сохраняя технический префикс и добавляя понятное человеческое имя. В `receipt` проставляются `toolName: "subagent"`, `targetHint: name` и `preview: task`.
  3. *[Секция Subagent Task и честный статус в Details]:*
     - В `details.tsx` для активных задач с живыми потомками выводится `Runtime status: Running in background`, а ложный `Outcome: Completed successfully` блокируется.
     - Добавлена секция `<InfoSection label="Subagent task">`, выводящая исходный промпт задачи в аккуратном скроллируемом блоке (`max-h-32 font-mono whitespace-pre-wrap break-all`).
  4. *[Стабилизация верстки сегмента и фиксация шапки Details]:*
     - В `segment.tsx` зафиксирована стабильная высота `max-h-64` (256px) как при наличии выбора, так и без него — исключены любые вертикальные скачки панели при клике по карточкам.
     - В десктопном режиме ширина инспектора ограничена `w-72 max-w-[45%]`, гарантируя, что дерево задач слева всегда сохраняет не менее 55% ширины.
     - В `details.tsx` шапка зафиксирована (`flex-shrink-0 border-b pb-1.5`), а скроллинг изолирован в теле (`flex-1 overflow-y-auto min-h-0`) — заголовок и кнопка `X` никогда не уплывают наверх при скролле.
- **TDD и доказательная база:**
  - `tests/ui/runtime-graph-subagent-active-and-details.test.ts`: 161 строка (< 200 LOC), 5 тестов, 100% pass:
    * Иконка `Play` (синяя) и живой таймер вместо `Check 1ms` при активном дочернем ходе.
    * Переключение на зелёный `Check` строго при завершении всех детей.
    * Отображение `Running in background` и блока `Subagent task` в Details с фиксированной шапкой.
    * Стабильная высота `max-h-64` и пропорциональная ширина `w-72 max-w-[45%]`.
    * Обогащение имени анкера из `SubagentsDoc` (`bb.subagent-anchor · subagent: Independent Reviewer`).
  - Общий сьют: **648 тестов (556 backend + 92 UI): 648 pass, 0 fail**.
  - Контракты: `npm run test:contracts` (Negative contract guard: TS2322 rejection pass).
  - Ацикличность импортов: `scripts/verify-import-graph.mjs` подтверждает 139 файлов, 0 циклов (Tarjan SCC).
  - Строгая типизация: `./node_modules/.bin/tsc --noEmit` (0 errors).
  - Line budgets (AP-019): все изменённые и новые файлы строго < 200 LOC.
- **Сборка (Build Receipt):**
  - Версия обновлена `0.3.13` → `0.3.14` в `package.json` и `package-lock.json`.
  - `npm run build` пересобрал бандлы: `dist/runner/index.js`, `dist/host.js`, `dist/server.js`, `dist/app.js`, `dist/app.css` с метаданными `pluginVersion: 0.3.14`.
- **Цель и статус:** Устранение избыточного раскрытия задач и паразитных кнопок `See more (1 completed)` внутри вызовов генераций, внедрение однострочных хлебных крошек для одиночных вызовов тулов, свёрнутости по умолчанию для задач с несколькими дочерними элементами и ограничение раскрытия истории строго корневым уровнем списка. Статус: **PASS (VERIFIED)**.
- **Устранённые дефекты и архитектурные решения:**
  1. *[Однострочные хлебные крошки (Single-Child Breadcrumbs)]:*
     - Первоисточник: последовательное исполнение ходов в `@earendil-works/pi-durable` (`finishToolRound` завершает текущую `pi.generation` и передаёт управление новой генерации через `handOver`). В типичных ходах генерация владеет ровно одним вызовом инструмента `pi.tool`.
     - Коренная причина: генерация с одним тулом отображалась в виде развёрнутого дерева с шевроном, занимая 2–3 строки и отображая паразитную кнопку `See more (1 completed)`.
     - Решение: в `src/ui/runtime-graph/node-row.tsx` и `tree.tsx` добавлена поддержка хлебных крошек `pi.generation #67 › read: src/foo.ts` на ровно одной строке без шеврона раскрытия. Клик по сегменту тула выбирает тул в инспекторе, клик по сегменту генерации — генерацию.
  2. *[Свёрнутость по умолчанию для задач с $\ge 2$ детьми]:*
     - Завершенные задачи с несколькими дочерними элементами по умолчанию находятся в свёрнутом состоянии (`ChevronRight`, отображают бейдж `(N tasks)`), занимая ровно 1 строку.
     - Задачи с активной работой (`hasActiveWork(item)`) остаются развёрнутыми во время исполнения для отображения live-прогресса и автоматически схлопываются по завершении.
  3. *[Изоляция раскрытия истории строго на корневом уровне]:*
     - Первоисточник бага: `tree-preview.ts` собирал первые 5 ID завершённых задач глобально по всему графу. Для длинных тредов (70+ задач) дочерние тулы последующих генераций объявлялись «скрытыми», порождая кнопки `See more (1 completed)` внутри ветвей.
     - Решение: фильтрация и кнопка `See more / See less` ограничены исключительно верхним (корневым) уровнем списка (`depth === 0`). Внутри генераций и подзадач кнопки истории полностью запрещены. На корневом уровне показываются первые 5 ходов, а кнопка раскрытия размещена внизу списка, разворачивая полную историю со скроллом.
- **TDD и доказательная база:**
  - `tests/ui/runtime-graph-breadcrumbs-and-root-folding.test.ts`: 176 строк (< 200 LOC), 4 теста, 100% pass:
    * Отрисовка генерации с 1 тулом в 1 строку без шеврона (`✓ pi.generation #67 › read: src/foo.ts`).
    * Выбор дочернего тула и родительской генерации по клику на соответствующие сегменты крошек.
    * Свёрнутость по умолчанию для мультидочерних генераций с бейджем `(2 tasks)` и разворачивание по клику.
    * Развёрнутость мультидочерних задач с активным live-прогрессом.
    * Корневое сворачивание истории (> 5 задач) внизу списка с переключением `See more` / `See less`.
  - Общий сьют: **643 теста (556 backend + 87 UI): 643 pass, 0 fail**.
  - Контракты: `npm run test:contracts` (Negative contract guard: TS2322 rejection pass).
  - Ацикличность импортов: `scripts/verify-import-graph.mjs` подтверждает 139 файлов, 0 циклов (Tarjan SCC).
  - Строгая типизация: `./node_modules/.bin/tsc --noEmit` (0 errors).
  - Line budgets (AP-019): все изменённые и новые файлы строго < 200 LOC.
- **Сборка (Build Receipt):**
  - Версия обновлена `0.3.12` → `0.3.13` в `package.json` и `package-lock.json`.
  - `npm run build` пересобрал бандлы: `dist/runner/index.js`, `dist/host.js`, `dist/server.js`, `dist/app.js`, `dist/app.css` с метаданными `pluginVersion: 0.3.13`.

### Native BB Mirror Recovery & Bounded Retention (Cycle 81) — 2026-10-28 (Execution Receipt)
- **Цель и статус:** Устранение дефектов восстановления дочерних бесед после перезапуска демона, предотвращение зависания возобновляемых тредов через ложную mirror adoption, честное согласование прерванных инструментов (orphan cards) и ограниченное удержание снимков/событий в памяти без нарушения late-binding. Статус: **PASS (SOURCE READY)**.
- **Устранённые дефекты и архитектурные решения:**
  1. *[Устранение сбоя восстановления связей (Offline Bindings Recovery)]:*
     - Первоисточник: `durable-binding-store.ts` парсил SQLite document_revisions, спотыкаясь о приватные дельта-массивы Chord.
     - Решение: `DurableBindingManager` сохраняет явный адаптерный манифест `adapter-bindings.json` в директории сессии. При старте дочернего треда до родителя (`child before parent`) `SessionRegistry.createOrGet` захватывает sole owner admission, поднимает родителя, который гидратирует связки через публичный `harness.snapshot(BindingIndexDoc)`. При неоднозначности идентичности сессия аварийно завершается (`fail closed`), исключая создание ложных standalone root сессий.
  2. *[Восстановление жизненного цикла Subagent Watcher]:*
     - `startSubagentWatcher` при инициализации раннера выполняет bootstrap известных дочерних бесед из `BindingIndexDoc` и `SubagentsDoc`.
     - Контроллер экспортирует метод `ensureAttached(conversationId)`, который вызывается в `session-commands.ts` перед выполнением `prompt`/`steer` на дочерней беседе, предотвращая «глухие» ходы после перезапуска.
  3. *[Изоляция Mirror Adoption и предотвращение поглощения ввода]:*
     - `decideMirrorAdoption` ограничен строго первоначальным рукопожатием первого хода (`!initialTurnConsumed`). Resumes и повторные ходы направляются непосредственно в `session.prompt()`.
     - При прерывании (`handleThreadStop` с `intent: "interrupt"`) флаг `initialTurnConsumed` взводится, гарантируя, что возобновление создаст реальную работу в Pi Durable.
  4. *[Честное согласование осиротевших карточек инструментов (Orphan Cards)]:*
     - Реализован `ToolItemReconciler`, сохраняющий курсор открытых инструментов адаптера в `adapter-active-items.json`.
     - При реконнекте или прерывании не закрытые вовремя инструменты согласуются в статус `failed` с причиной прерывания, исключая зависшие «Running» карточки в UI без фальсификации успеха.
  5. *[Ограниченное удержание памяти (Bounded Mirror Retention)]:*
     - `SubagentMirrorManager` выполняет коалесценцию повторяемых снимков `runtime_graph_snapshot` (сохраняется только последний снимок).
     - Буфер событий ограничен 100 записями с честным флагом `isTruncated`, вывод ограничен 64 КБ. Тяжёлые буферы освобождаются при `consumeCompleted` и `flushBufferedDeltas` без нарушения late adoption.
- **TDD и доказательная база:**
  - 5 новых сьютов (< 200 LOC каждый, 13 тестов, 100% pass):
    * `tests/subagent-recovery-binding.test.ts`: манифест связок, child-before-parent, fail-closed.
    * `tests/subagent-watcher-lifecycle.test.ts`: bootstrap существующих дочерних бесед, ensureAttached.
    * `tests/subagent-resume-adoption.test.ts`: предотвращение поглощения ввода при возобновлении.
    * `tests/orphan-tool-reconciliation.test.ts`: честное закрытие осиротевших инструментов.
    * `tests/subagent-mirror-retention.test.ts`: коалесценция снимков, ограничение буферов.
  - Общий сьют: **632 теста (556 backend + 76 UI): 632 pass, 0 fail**.
  - Контракты: `npm run test:contracts` (Negative contract guard: TS2322 rejection pass).
  - Ацикличность импортов: `npm test` подтверждает 0 циклов (Tarjan SCC).
  - Строгая типизация: `npx tsc --noEmit` (0 errors).
  - Line budgets (AP-019): все изменённые и новые файлы строго < 200 LOC.
- **Файловый артефакт:** `/Users/vanya/.bb/thread-storage/thr_ct3kk9xne6/backend-mirror-recovery-remediation-result.md`.

### Live and Terminal Task Token Usage in Task Graph (Cycle 84) — 2026-10-28 (Execution Receipt)
- **Цель и статус:** Вывод расхода токенов для задач генерации (`pi.generation` и крошек `pi.generation › tool`) в строке дерева задач перед таймингом (`duration`), обновляемого на лету при инференсе, и детальной раскладки в инспекторе Details. Статус: **PASS (VERIFIED)**.
- **Устранённые дефекты и архитектурные решения:**
  1. *[Контракты и DTO токенов (AP-010, AP-013)]:*
     - В `src/runtime-graph/types.ts` и `schema.ts` добавлен типизированный контракт `TaskTokensUsage` (`total`, `input`, `output`, `reasoning`, `cacheRead`).
     - Расширены `RuntimeTaskNode` (для live-задач) и `RuntimeTaskReceipt` (для завершённых задач).
  2. *[Изолированный форматтер токенов (AP-019)]:*
     - Создан модуль `src/ui/runtime-graph/token-format.ts` (46 LOC < 200).
     - Функция `formatTokens(tokens)` форматирует значения компактно (`450 tok`, `1.4k tok`, `12k tok`, `1.5M tok`).
     - Функция `formatDetailedTokens(tokens)` формирует структурированную раскладку для инспектора (`1,420 total (1,100 in · 320 out · 250 reasoning)`).
  3. *[Извлечение токенов в раннере (AP-026)]:*
     - Создан модуль `src/runner/task-tokens.ts` (74 LOC < 200).
     - `extractLiveTokens` извлекает live usage из `pi.live` (`live.generation.message.usage`) во время стриминга.
     - `extractTerminalTokens` извлекает авторитетный usage завершённой генерации из `AssistantEntry` через `task.state.outcome.result.entryId`.
  4. *[Отображение в строке списка и инспекторе]:*
     - В `src/ui/runtime-graph/node-row.tsx`: перед `duration` рендерится моноширинный бейдж токенов (`1.4k tok · 1.4s`), тикающий в реальном времени при генерации.
     - В `src/ui/runtime-graph/details.tsx`: добавлена строка `Tokens` с полной раскладкой токенов.
- **TDD и доказательная база:**
  - `tests/ui/runtime-graph-tokens.test.ts`: 119 LOC (< 200 LOC), 7 тестов, 100% pass:
    * Форматирование компактных токенов `formatTokens` (граничные значения, null, тысячи, миллионы).
    * Детальное форматирование `formatDetailedTokens`.
    * Извлечение live токенов из `pi.live`.
    * Извлечение terminal токенов из `AssistantEntry`.
    * Отрисовка бейджа токенов перед `duration` в строке дерева.
    * Отрисовка live-токенов активной задачи.
    * Отрисовка строки `Tokens` в панели Details.
  - Общий сьют: **655 тестов (556 backend + 99 UI): 655 pass, 0 fail**.
  - Контракты: `npm run test:contracts` (Negative contract guard: TS2322 rejection pass).
  - Ацикличность импортов: `node scripts/verify-import-graph.mjs` подтверждает 141 файл, 0 циклов (Tarjan SCC).
  - Строгая типизация: `npx tsc --noEmit` (0 errors).
  - Line budgets (AP-019): все изменённые и новые файлы строго < 200 LOC:
    * `src/ui/runtime-graph/token-format.ts`: 46 LOC
    * `src/runner/task-tokens.ts`: 74 LOC
    * `src/runtime-graph/types.ts`: 148 LOC
    * `src/runtime-graph/schema.ts`: 179 LOC
    * `src/runner/runtime-graph-receipts.ts`: 156 LOC
    * `src/runner/runtime-graph-mapper.ts`: 193 LOC
    * `src/ui/runtime-graph/node-row.tsx`: 191 LOC
    * `src/ui/runtime-graph/details.tsx`: 165 LOC
    * `tests/ui/runtime-graph-tokens.test.ts`: 119 LOC
- **Сборка (Build Receipt):**
  - Версия обновлена `0.3.14` → `0.3.15` в `package.json` и `package-lock.json`.
  - `npm run build` пересобрал бандлы: `dist/runner/index.js`, `dist/host.js`, `dist/server.js`, `dist/app.js`, `dist/app.css` с метаданными `pluginVersion: 0.3.15`.

### Reverse Chronology in Task Graph & Preview (Cycle 85) — 2026-10-29 (Execution Receipt)
- **Цель и статус:** Исправление порядка задач в таск-графе: инверсия в обратную хронологию (самые свежие задачи строго сверху по убыванию ID: `b.id - a.id`), сохранение активных задач в верхнем приоритете, и показ в превью 5 самых свежих завершённых задач с фолдингом старой истории вниз под кнопку `See more`. Статус: **PASS (VERIFIED)**.
- **Устранённые дефекты и архитектурные решения:**
  1. *[Инверсия сортировки в представлении графа (AP-010, AP-026)]:*
     - В `src/ui/runtime-graph/tree-order.ts` (`sortTreeActiveFirst`): активные и завершённые задачи сортируются строго по убыванию ID (`b.id - a.id`).
     - В `src/ui/runtime-graph/tree.tsx` (`renderBranch`): группы `active` и `finished` сортируются `b.id - a.id`. Самые новые задачи рендерятся первыми.
  2. *[Превью 5 самых свежих завершённых задач (AP-026, AP-028)]:*
     - В `src/ui/runtime-graph/tree-preview.ts` (`computePreviewFinishedIds`): `finished` сортируется `b.id - a.id`, поэтому в `previewSlice` попадают 5 самых последних завершённых задач (`targetFinishedCount`), а более ранние исторические задачи скрываются под кнопку `See more (N completed)`.
     - При раскрытии истории (`See less`) список раскрывается от самых свежих к самым старым, а кнопка сворачивания находится внизу.
  3. *[Сохранение интерактивности и фокуса инспектора]:*
     - При клике на задачу из свернутой истории ветка раскрывается и фокус инспектора удерживается.
- **TDD и доказательная база:**
  - Обновлены и адаптированы тесты:
    * `tests/ui/runtime-graph-active-first-and-folding.test.ts` (139 LOC < 200).
    * `tests/ui/runtime-graph-preview.test.ts` (121 LOC < 200): проверено точное совпадение ID строк через `data-task-id` (для 100 задач в превью рендерятся строго #100, #99, #98, #97, #96).
    * `tests/ui/runtime-graph-breakdown-spacing.test.ts` (94 LOC < 200).
    * `tests/ui/runtime-graph-nine-point-geometry.test.ts` (164 LOC < 200).
    * `tests/ui/runtime-graph-six-point-feedback.test.ts` (177 LOC < 200).
  - Общий сьют: **655 тестов (556 backend + 99 UI): 655 pass, 0 fail**.
  - Контракты: `npm run test:contracts` (Negative contract guard: TS2322 rejection pass).
  - Ацикличность импортов: `node scripts/verify-import-graph.mjs` (141 файл, 0 циклов).
  - Строгая типизация: `npx tsc --noEmit` (0 errors).
  - Line budgets (AP-019): все файлы строго < 200 LOC.
- **Сборка (Build Receipt):**
  - Версия обновлена `0.3.15` → `0.3.16` в `package.json` и `package-lock.json`.
  - `npm run build` пересобрал бандлы: `dist/server.js`, `dist/app.js`, `dist/host.js` с версией `0.3.16`.

### Task Row Tabular Alignment & Token Delta (Cycle 86) — 2026-10-29 (Execution Receipt)
- **Цель и статус:** Исправление отображения цифр в строках таск-графа: замена общего накопленного числа токенов на честный прирост с прошлого шага (`+1.4k`, `+450`, `+0`), замена текста `tok` на аккуратную иконку `Sparkles` (искры), и фиксация позиций секунд и токенов в моноширинных табличных слотах с разделителем `·`, начинающихся строго от одной невидимой вертикальной линии. Статус: **PASS (VERIFIED)**.
- **Устранённые дефекты и архитектурные решения:**
  1. *[Честная дельта контекста между шагами (AP-010, AP-026)]:*
     - В `src/ui/runtime-graph/tree-builder.ts`: дельта токенов вычисляется хронологически по возрастанию ID внутри каждой `conversationId` ($T_i - T_{i-1}$, для первого шага $T_1 = total$).
     - В `src/ui/runtime-graph/types.ts`: добавлено опциональное поле `tokenDelta?: number` в `TaskTreeItem`.
     - В `src/ui/runtime-graph/token-format.ts`: добавлена функция `formatTokenDelta(delta)` (`+1.4k`, `+450`, `+0`, `-15k`).
  2. *[Иконка Sparkles вместо слова `tok` (AP-069)]:*
     - Создан изолированный компонент `src/ui/runtime-graph/token-icon.tsx` (`SparklesIcon`, 28 LOC < 200).
     - Текст `tok` заменён на значок искр `Sparkles`, цвет `text-amber-500/80` (аккуратный золотистый оттенок AI).
  3. *[Табличное выравнивание и устранение волн (AP-019, AP-069)]:*
     - Создан компонент `src/ui/runtime-graph/node-row-metrics.tsx` (51 LOC < 200).
     - Колонка токенов: фиксированный слот `w-[4.25rem]`, выравнивание `justify-start` (цифры `+1.4k` начинаются строго от одной вертикальной линии).
     - Разделитель: фиксированный `·` (`text-muted-foreground/30 px-1.5`).
     - Колонка секунд: фиксированный слот `w-[3.25rem]`, выравнивание `justify-start` (цифры секунд начинаются строго от одной вертикальной линии).
     - При отсутствии токенов на строке (например, тул без модели) слот токенов остаётся пустым, а разделитель и секунды остаются на тех же координатах.
- **TDD и доказательная база:**
  - Обновлены и расширены тесты:
    * `tests/ui/runtime-graph-tokens.test.ts` (132 LOC < 200): проверены `formatTokenDelta`, рендеринг `SparklesIcon`, дельта, разделитель и длительность.
    * `tests/ui/runtime-graph-tree-builder.test.ts` (98 LOC < 200): проверен хронологический расчёт дельты по шагам.
  - Общий сьют: **657 тестов (556 backend + 101 UI): 657 pass, 0 fail**.
  - Контракты: `npm run test:contracts` (Negative contract guard: TS2322 pass).
  - Ацикличность импортов: `node scripts/verify-import-graph.mjs` (143 файла, 0 циклов).
  - Строгая типизация: `npx tsc --noEmit` (0 errors).
  - Line budgets (AP-019): все файлы строго < 200 LOC:
    * `src/ui/runtime-graph/node-row.tsx`: 187 LOC
    * `src/ui/runtime-graph/node-row-metrics.tsx`: 51 LOC
    * `src/ui/runtime-graph/token-icon.tsx`: 28 LOC
    * `src/ui/runtime-graph/token-format.ts`: 68 LOC
    * `src/ui/runtime-graph/tree-builder.ts`: 167 LOC
- **Сборка (Build Receipt):**
  - Версия обновлена `0.3.16` → `0.3.17` в `package.json` и `package-lock.json`.
  - `npm run build` пересобрал бандлы: `dist/server.js`, `dist/app.js`, `dist/host.js` с версией `0.3.17`.

### Direct Step Output Tokens & Muted Icon Alignment (Cycle 87) — 2026-10-29 (Execution Receipt)
- **Цель и статус:** Устранение бага с ложным `+0` на задачах `pi.generation` (задача #785 генерировала 320 токенов, но из-за кросс-тасковой дельты `total - prev` отображался `0`), перенос иконки токенов `Sparkles` перед цифрами без знака `+` для устранения визуальных скачков ширины, и смягчение цвета иконки под цвет шрифта (`text-muted-foreground/60`). Статус: **PASS (VERIFIED)**.
- **Устранённые дефекты и архитектурные решения:**
  1. *[Точность подсчёта токенов генерации (AP-010, AP-026)]:*
     - В `src/ui/runtime-graph/node-row.tsx`: токенное значение шага вычисляется напрямую из `tokensUsage.output` (фактический выхлоп генерации текущего хода). Для задачи #785 выводится точное значение `320`, полностью соответствующее строке `320 out` в инспекторе деталей, исключая ложные нули от неизменного кеша промпта.
     - Сохранён фоллбек на дельту и total при отсутствии раздельного `output`.
  2. *[Иконка перед цифрами и удаление знака `+` (AP-069)]:*
     - В `src/ui/runtime-graph/token-format.ts`: добавлена функция `formatStepTokens(tokens)`, форматирующая число без знака `+` (`320`, `1.4k`, `17k`, `1.2M`).
     - В `src/ui/runtime-graph/node-row-metrics.tsx`: иконка `SparklesIcon` перенесена **перед цифрами** (`✨ 320`).
     - Все строки с токенами начинаются строго с иконки на левой невидимой линии слота `w-[3.75rem]`, исключая скачки ширины между строками.
  3. *[Приглушённый цвет иконки (AP-069)]:*
     - Цвет `SparklesIcon` изменён с акцентного `text-amber-500` на мягкий монохромный `text-muted-foreground/60` (hover: `text-foreground`), не перегружающий визуальную иерархию.
- **TDD и доказательная база:**
  - Обновлены и расширены тесты:
    * `tests/ui/runtime-graph-tokens.test.ts` (162 LOC < 200): добавлены тесты `formatStepTokens`, рендеринг задачи #785 с 320 токенами без нуля, unsigned вид с левой иконкой.
  - Общий сьют: **659 тестов (556 backend + 103 UI): 659 pass, 0 fail**.
  - Контракты: `npm run test:contracts` (TS2322 negative guard pass).
  - Ацикличность импортов: `node scripts/verify-import-graph.mjs` (143 файла, 0 циклов).
  - Строгая типизация: `npx tsc --noEmit` (0 errors).
  - Line budgets (AP-019): все файлы строго < 200 LOC:
    * `src/ui/runtime-graph/node-row.tsx`: 192 LOC
    * `src/ui/runtime-graph/node-row-metrics.tsx`: 52 LOC
    * `src/ui/runtime-graph/token-icon.tsx`: 28 LOC
    * `src/ui/runtime-graph/token-format.ts`: 89 LOC
    * `src/ui/runtime-graph/tree-builder.ts`: 167 LOC
    * `tests/ui/runtime-graph-tokens.test.ts`: 162 LOC
- **Сборка (Build Receipt):**
  - Версия обновлена `0.3.17` → `0.3.18` в `package.json` и `package-lock.json`.
  - `npm run build` пересобрал бандлы: `dist/server.js`, `dist/app.js`, `dist/host.js` с версией `0.3.18`.

### Active Step Tokens Sum (Cycle 88) — 2026-10-29 (Execution Receipt)
- **Цель и статус:** Исправление расчёта токенов шага: вместо изолированного `output` вычисляется честная сумма всех активных (некешированных) токенов текущего шага (`input + output + reasoning`). Для таски с `2,891 in · 85 out · 29 reasoning` отображается `3k` (2891 + 85 + 29 = 3005), а в тултипе выводится полный расклад. Статус: **PASS (VERIFIED)**.
- **Устранённые дефекты и архитектурные решения:**
  1. *[Честная сумма активных токенов шага (AP-010, AP-026)]:*
     - В `src/ui/runtime-graph/token-format.ts`: добавлена функция `calculateStepTokens(usage)`, вычисляющая `(input ?? 0) + (output ?? 0) + (reasoning ?? 0)`.
     - При наличии кеша (`cacheRead`), эта сумма в точности равна всем новым токенам, отправленным и сгенерированным в рамках этого хода (`total - cacheRead`).
     - Сохранены безопасные фоллбеки на `total - cacheRead` и `total`.
  2. *[Детализированный тултип на строке (AP-069)]:*
     - В `src/ui/runtime-graph/node-row.tsx`: формируется точный тултип: `3,005 step tokens (2,891 in · 85 out · 29 reasoning) · 367,740 total`.
     - Значение в строке (`✨ 3k`) полностью согласуется с числами в инспекторе деталей.
- **TDD и доказательная база:**
  - Обновлены и расширены тесты:
    * `tests/ui/runtime-graph-tokens.test.ts` (174 LOC < 200): проверены `calculateStepTokens`, сумма `2891 in + 85 out + 29 reasoning = 3005` (`3k`).
  - Общий сьют: **660 тестов (556 backend + 104 UI): 660 pass, 0 fail**.
  - Контракты: `npm run test:contracts` (TS2322 negative guard pass).
  - Ацикличность импортов: `node scripts/verify-import-graph.mjs` (143 файла, 0 циклов).
  - Строгая типизация: `npx tsc --noEmit` (0 errors).
  - Line budgets (AP-019): все файлы строго < 200 LOC:
    * `src/ui/runtime-graph/node-row.tsx`: 196 LOC
    * `src/ui/runtime-graph/node-row-metrics.tsx`: 48 LOC
    * `src/ui/runtime-graph/token-icon.tsx`: 28 LOC
    * `src/ui/runtime-graph/token-format.ts`: 109 LOC
    * `src/ui/runtime-graph/tree-builder.ts`: 167 LOC
    * `tests/ui/runtime-graph-tokens.test.ts`: 174 LOC
- **Сборка (Build Receipt):**
  - Версия обновлена `0.3.18` → `0.3.19` в `package.json` и `package-lock.json`.
  - `npm run build` пересобрал бандлы: `dist/server.js`, `dist/app.js`, `dist/host.js` с версией `0.3.19`.

### Eliminate Token Fallback & Exact Entry Binding (Cycle 89) — 2026-10-29 (Execution Receipt)
- **Цель и статус:** Устранение критического дефекта дублирования токенов между последовательными задачами генерации («токен в токен», например таски #9148 и #9153 в `@thread:thr_axjptvcdki` обе показывали 350,834 total / 11k): вырезание слепого фоллбека на последнее ассистентское сообщение, привязка записей напрямую из стрима коммитов (`pub.changes`, `type: "entry"`) и автоматический бекфилл по `entryId` при обновлении вью. Статус: **PASS (VERIFIED)**.
- **Устранённые дефекты и архитектурные решения:**
  1. *[Искоренение слепого фоллбека (AP-026)]:*
     - В `src/runner/task-tokens.ts`: полностью удалён цикл-фоллбек, бравший последнее ассистентское сообщение при отсутствии `entryId`. Если запись ещё не найдена, честно возвращается `undefined`, исключая присвоение чужих токенов.
     - Поиск по `entryId` теперь проверяет `recentEntries` и `cur.conversation.entries` строго по точному равенству идентификатора.
  2. *[Захват свежих записей из коммит-публикаций (AP-010, AP-026)]:*
     - В `src/runner/runtime-graph-source.ts`: добавлен буфер `recentEntries` (Map до 256 записей). При получении `pub.changes` с `type: "entry"` сущность сохраняется синхронно.
     - При коммите терминальной таски `recentEntries` передаётся в `recordTerminalWithDetails`, исключая задержку между коммитом таски и обновлением реактивного вью `viewSource`.
  3. *[Бекфилл токенов при обновлении вью (AP-026)]:*
     - В `src/runner/runtime-graph-receipts.ts`: добавлен метод `backfillTokensFromEntries(entries)` и трекинг `pendingEntryIds`. Если на момент коммита таски запись ещё не была прочитана, при первом же тике обновления вью точные токены извлекаются по сохранённому `entryId` без дублирования.
- **TDD и доказательная база:**
  - Обновлены и расширены тесты:
    * `tests/ui/runtime-graph-tokens.test.ts` (188 LOC < 200): добавлен негативный тест AP-026 (возврат `undefined` при отсутствии `entryId` в массиве вместо воровства старой записи) и позитивный тест разрешения из `recentEntries`.
  - Общий сьют: **662 теста (556 backend + 106 UI): 662 pass, 0 fail**.
  - Контракты: `npm run test:contracts` (TS2322 negative guard pass).
  - Ацикличность импортов: `node scripts/verify-import-graph.mjs` (143 файла, 0 циклов).
  - Строгая типизация: `npx tsc --noEmit` (0 errors).
  - Line budgets (AP-019): все файлы строго < 200 LOC:
    * `src/runner/task-tokens.ts`: 80 LOC
    * `src/runner/runtime-graph-source.ts`: 193 LOC
    * `src/runner/runtime-graph-mapper.ts`: 197 LOC
    * `src/runner/runtime-graph-receipts.ts`: 191 LOC
    * `tests/ui/runtime-graph-tokens.test.ts`: 188 LOC
- **Сборка (Build Receipt):**
  - Версия обновлена `0.3.19` → `0.3.20` в `package.json` и `package-lock.json`.
  - `npm run build` пересобрал бандлы: `dist/server.js`, `dist/app.js`, `dist/host.js` с версией `0.3.20`.

### Foreground subagent strict-JSON record (Cycle 90) — 2026-10-29

- Explicit user grant: fix the discovered foreground subagent defect and finish
  POC verification; no unrelated refactor, upstream edit, install or restart.
- One-line fix: omit optional anchorTaskId when no anchor exists. Foreground
  records no longer assign undefined into Chord; background anchors/reporters,
  ownership, model policy and replay/reuse are unchanged.
- RED/GREEN: new focused regression crosses the real Chord document assignment
  boundary and executes the child to a result; foreground and background pass.
- Independent scoped code review: PASS, no open P0/P1/P2. Source and test hashes
  checked; source 184 lines, test 131 lines. AP-012/AP-013/AP-019/AP-023/AP-026/AP-028.
- Builder: contracts and full suite passed (558 backend + 106 UI = 664); the
  downstream YAML POC's 39 tests also passed. Exactly one patch reservation,
  0.3.20 -> 0.3.21, before ordinary build; package/lock and all three dist metadata
  versions agree. No second bump during mechanical commit.
- Actual native SDK/model verification on an owned MemoryStorage session:
  direct review -> gate -> accepted, plus review FAIL -> repair -> review PASS
  -> gate -> accepted (one repair). Real foreground child conversations observed
  in the same native Task Graph; no fake ToolApi or background ownership bypass.
  First direct-run attempt hit its bounded timeout; unchanged-source rerun passed.
  Repair workflow tool completed accepted before the global budget, but the root
  agent's final post-tool response settled unanswered at that budget. This is
  workflow-tool acceptance, NOT a claim of full root-conversation smoke PASS.
- Installed BB plugin and resident runtime were NOT updated/restarted. SDK source
  verification and successful local dist build are not installed-runtime acceptance.
- Source/test author, independent reviewer and builder were separate; parent
  performs only ready-file mechanical delivery after these evidence gates.

### Breadcrumb nested tools expansion and chevron visibility (Cycle 91) — 2026-10-29

- Defect: Single-child breadcrumbs (`generation › tool`) dropped nested subtasks
  when the child tool had its own children (e.g. `codemode`, nested subagents).
  `node-row.tsx` suppressed chevrons via `!singleChild && ...` and omitted the task count badge,
  while `tree.tsx` evaluated `isMultiChild` to false and never rendered the nested branch.
- Fix:
  - `src/ui/runtime-graph/node-row.tsx`: `hasChildren = singleChild ? singleChild.children.length > 0 : item.children.length > 0`. Shows `(${singleChild.children.length} tasks)` count hint next to breadcrumb and displays expansion chevron.
  - `src/ui/runtime-graph/tree.tsx`: delegates `expandableChildren = singleChild ? singleChild.children : item.children`, honors `hasActiveWork(singleChild ?? item)` for default collapse state, and renders `renderBranch(expandableChildren, depth + 1)`.
- Verification: 666 tests pass (558 backend + 108 UI). Verified with real live thread snapshots (`thr_axjptvcdki`). Leaf tool breadcrumbs remain 1-line compact without chevrons, while nested tool calls display chevrons and expand all subtasks indented.
- Line budgets: `node-row.tsx` (196 LOC), `tree.tsx` (188 LOC) strictly < 200 LOC.
- **Сборка (Build Receipt):**
  - Версия обновлена `0.3.21` → `0.3.22` в `package.json` и `package-lock.json`.
  - `npm run build` пересобрал бандлы: `dist/server.js`, `dist/app.js`, `dist/host.js` с версией `0.3.22`.

### Responsive row width & elimination of artificial label truncation (Cycle 92) — 2026-10-29

- Defect: Hardcoded CSS max-width ceilings (`max-w-[170px]` for breadcrumb child and `max-w-[220px]` for leaf rows) prematurely truncated commands and file paths with ellipsis even when hundreds of pixels of horizontal card width were completely empty.
- Fix:
  - `src/ui/runtime-graph/node-row.tsx`: replaced `max-w-[170px]` with `truncate min-w-0 font-medium` for breadcrumb child and `max-w-[220px]` with `truncate min-w-0` for leaf tasks, while retaining `truncate max-w-[140px] flex-shrink-0` for parent turn labels. Labels now fluidly expand to the right-aligned metrics without artificial cutoff.
- Verification: 667 tests pass (558 backend + 109 UI). Added `tests/ui/runtime-graph-responsive-width.test.ts` to assert absence of hardcoded pixel ceilings and presence of `min-w-0` fluid expansion. Verified live on `thr_axjptvcdki` snapshot.
- Line budgets: `node-row.tsx` (196 LOC), `tests/ui/runtime-graph-responsive-width.test.ts` (54 LOC) strictly < 200 LOC.
- **Сборка (Build Receipt):**
  - Версия обновлена `0.3.22` → `0.3.23` в `package.json` и `package-lock.json`.
  - `npm run build` пересобрал бандлы: `dist/server.js`, `dist/app.js`, `dist/host.js` с версией `0.3.23`.

### Full-width labels & 128-char target hint alignment (Cycle 93) — 2026-10-29

- Defect: Even with responsive flexbox, labels were still truncated at 48 characters because `src/runner/task-labels.ts` clipped `targetHint` to `MAX_NAME = 48` on the backend, and `node-row.tsx` truncated the parent generation turn to `assistant turn · ...` due to a redundant `· waiting on N` string inside a `max-w-[140px]` span.
- Fix:
  - `src/runner/task-labels.ts`: introduced `MAX_TARGET_HINT = 128` aligned with `schema.ts`, allowing file paths and commands to retain up to 128 chars while keeping `preview` at 48 for planSteps compatibility.
  - `src/ui/runtime-graph/node-row.tsx`: in `resolveItemLabel`, stripped redundant ` · waiting on N` (since the amber badge already displays waiting task IDs); expanded breadcrumb parent max-width to `max-w-[280px]` so model/provider names fit cleanly without ellipsis.
- Verification: 669 tests pass (558 backend + 111 UI). Added regression tests in `tests/ui/runtime-graph-responsive-width.test.ts`. Verified live on `thr_axjptvcdki` snapshot.
- Line budgets: `node-row.tsx` (197 LOC), `task-labels.ts` (107 LOC), `tests/ui/runtime-graph-responsive-width.test.ts` (97 LOC) strictly < 200 LOC.
- **Сборка (Build Receipt):**
  - Версия обновлена `0.3.23` → `0.3.24` в `package.json` и `package-lock.json`.
  - `npm run build` пересобрал бандлы: `dist/server.js`, `dist/app.js`, `dist/host.js`, `dist/runner/index.js` с версией `0.3.24`.


### Subagent Mirror Correlation, Stream Isolation & Child Thread Independence (Cycle 97) — 2026-10-30

- **Цель и статус:** Разделение жизненного цикла обычных дочерних тредов Beyond Boundaries (пользовательские сабтреды, форки, visual-workflows) и нативных зеркал субагентов Pi Durable; детерминированная корреляция через версионированный конверт; полная изоляция дочерних событий от родительского таймлайна (summary only). Статус: **PASS (VERIFIED)**.
- **Устранённые дефекты и первоисточники:**
  - *Захват и падение обычных дочерних тредов (AP-011, AP-026):* В `SessionRegistry.createOrGet` любой тред с `parent_thread_id` безусловно трактовался как зеркало субагента и пытался привязаться к сессии родителя. Обычные дочерние треды пользователей не имели записи субагента в памяти родителя и крашились с `Cannot resolve native child conversation`. Решение: не-зеркальные дочерние треды теперь детерминированно порождают автономные изолированные сессии раннера без падения и захвата сессии родителя.
  - *Коллизии одинаковых промптов и подделка сессий (AP-034, AP-048):* Введён типизированный конверт `[bb:pi-subagent-mirror:v1 session=<sKey> parent=<pId> conv=<cId>]`, связывающий тред со своей дочерней беседой без зависимости от порядка вывода CLI и без коллизий при идентичных текстах задач. Конверт проверяется строгим regex (`SAFE_SESSION_KEY_REGEX`), отвергает подделку корневых бесед (`conv >= 2`, запрет `conv=01`) и чисто срезается до отправки в модель Pi.
  - *Утечка детских событий и turn_start в родителя (AP-010, AP-021, AP-023):* `session-subagent-handler.ts` изолирует все события дочерних бесед (`conv >= 2`) строго в зеркальный тред (с буферизацией при отложенной привязке). В родительский таймлайн передаётся только карточка инструмента `delegation` со сводкой `summary`, что устраняет непарные `turn.open` и поломку отображения чата в BB.
  - *Изоляция отмены и совместного старта (AP-012, AP-026):* В `SessionAdmissionCoordinator` обычные дочерние треды не передают `parentThreadId`, что предотвращает ошибочное объединение промисов с родителем и случайный abort дочернего треда при остановке родителя.
- **TDD и доказательная база:**
  - Приёмочные пробы координатора (`identity-probes.mjs`): 5 из 5 PASS (проверены изоляция обычного ребёнка, отказ неизвестной беседы, защита от кражи чужой беседы, холодный старт и запрет корневых псевдонимов `conv=01`).
  - Таргетированный сьют: 58 тестов в 15 файлах — 100% PASS.
  - Полный сьют тестов: **580 тестов бэкенда pass + 117 тестов UI pass = 697 pass, 0 fail**.
  - Контракты и типизация: `npm run test:contracts` (0 errors), `npx tsc --noEmit` (0 errors).
  - Ацикличность импортов: `node scripts/verify-import-graph.mjs` (0 циклов, 57 файлов).
- **Line Budgets (AP-019):**
  - `src/shared/subagent-envelope.ts`: 92 строки (< 200)
  - `src/host/subthread-spawner.ts`: 168 строк (< 200)
  - `src/host/session-subagent-handler.ts`: 188 строк (< 200)
  - `src/host/session-registry.ts`: 241 строка (< 250 hard limit)
  - `src/host/bridge-router.ts`: 199 строк (< 200)
  - `src/host/child-turn-guard.ts`: 189 строк (< 200)
  - Все тестовые файлы (включая распиленный `host-subthread-envelope.test.ts` и `host-subthread-envelope-errors.test.ts`) строго < 250 строк.
- **Сборка (Build Receipt):**
  - Версия обновлена `0.3.27` → `0.3.28` в `package.json` и `package-lock.json`.
  - `npm run build` пересобрал дистрибутивы: `dist/server.js`, `dist/app.js`, `dist/host.js`, `dist/runner/index.js` с версией `0.3.28`.

### Deterministic Subagent Mirror Attachment & Clean Architecture Review (Cycle 96) — 2026-10-30

- **Цель и статус:** Устранение стохастического падения зеркальных тредов субагентов `Cannot resolve native child conversation for thread <childId> under parent <parentThreadId>` при спавне через `subagent` tool с полным соблюдением Clean Architecture (без пустых catch, без нечётких эвристик, без избыточных фолбэков). Статус: **PASS (VERIFIED)**.
- **Устранённые дефекты и первоисточники:**
  - *Коренная причина (Race Condition):* Сервер BB при создании треда возвращает ответ CLI асинхронно до завершения `thread/start`. Если RPC `thread/start` поступает от демона раньше, чем `bb thread spawn` CLI вернёт `stdout` и вызовет `session.registerThread`, идентификатор `conversationId` в памяти сессии ещё отсутствует, а параметры RPC `params.input` и `params.task` пусты. В результате `SessionRegistry.createOrGet` не мог найти беседу и падал с фатальной ошибкой.
  - *Архитектурный рефакторинг (Arch Improvement Loop & AP-012/AP-019/AP-026):*
    1. `src/host/subthread-spawner.ts`: `resolveThreadContextFromDb` переведён на единый типизированный канонический запрос `SELECT project_id, environment_id, parent_thread_id, startup_context FROM threads WHERE id = ?`. Устранены двойные запросы, пустые catch-блоки и избыточное чтение таблицы events. Извлечение промпта валидирует контракт `request.input` и явно логирует structured warning при битом JSON.
    2. `src/host/subagent-mirror.ts`: Устранена нечёткая эвристика `startsWith` и удалён метод `getUnboundConversationId`. Сопоставление задачи в `pendingByTask` строгое детерминированное (`task.trim()`).
    3. `src/host/session-registry.ts`: Любой дочерний тред активного `parentThreadId` детерминированно привязывается к общей сессии родителя через `attachShared` без попыток создания конкурирующих раннеров. `targetConvId` вычисляется строго из трёх причинных источников: явный composite id -> сопоставление задачи из `startup_context` в `pendingByTask` -> связывание по threadId. Если ни один не сошёлся — сессия честно и детерминированно завершается с ошибкой (fail-closed).
- **TDD и доказательная база:**
  - В `tests/host-subthread-shared-session.test.ts` обновлены тесты на соответствие реальной схеме BB Core (`startup_context`):
    * `createOrGet recovers targetConversationId and reuses parent session when thread/start arrives BEFORE CLI finishes` — PASS.
    * `createOrGet fails closed when startup_context task cannot be matched to any pending subagent` — PASS.
  - Общий сьют: **561 тест бэкенда pass + 117 тестов UI pass = 678 pass, 0 fail**.
  - Контракты: `npm run test:contracts` (Negative contract guard: TS2322 rejection, pass).
- **Line Budgets (AP-019):**
  - `src/host/subthread-spawner.ts`: 162 строки (< 200)
  - `src/host/subagent-mirror.ts`: 163 строки (< 200)
  - `src/host/session-registry.ts`: 205 строк (< 250)
  - `src/host/session.ts`: 199 строк (< 250)
  - `src/host/session-subagent-handler.ts`: 178 строк (< 200)
- **Сборка (Build Receipt):**
  - Версия обновлена `0.3.26` → `0.3.27` в `package.json` и `package-lock.json`.
  - `npm run build` пересобрал бандлы: `dist/server.js`, `dist/app.js`, `dist/host.js`, `dist/runner/index.js` с версией `0.3.27`.

