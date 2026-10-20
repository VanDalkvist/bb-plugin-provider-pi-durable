# Архитектурный аудит кодовой базы /tmp/diffuzmetall-adapter (Track 1, Cycle 93)

**Проект:** `bb-plugin-provider-pi-durable`  
**Дата:** 2026-10-20  
**Роль:** Независимый глубокий исследователь (Track 1)  
**Объект аудита:** `/tmp/diffuzmetall-adapter` (коммиты и кандидаты адаптера Diffuzmetall)  
**Статус:** Исчерпывающий технический отчет  

---

## 1. Резюме находок (Executive Summary)

В ходе независимого глубокого исследования кодовой базы `/tmp/diffuzmetall-adapter` проведен пофайловый анализ архитектурных решений, протоколов взаимодействия, механизмов наблюдения, проекции истории и тестового покрытия.

### Ключевые открытия:
1. **Детерминированный расчет CoherentOutcome (`src/outcome/`):** Полный отказ от эвристик, анализа текста модели или stopReason. Статус задачи выводится строго из журнала выполнения транзакций Durable Runtime (`SubmissionRecord`). Дополнительно реализовано двухфазное чтение с проверкой ревизий (Optimistic Concurrency Control) для исключения гонок при параллельных изменениях.
2. **Изолированный контроль и наблюдение за дочерними процессами (`src/native/`):** Реализована надежная модель управления субтредами (steer, prompt, abort) с жесткими лимитами буферов (`512 KiB` на ввод, `1 MiB` на IPC-фрейм, `8 MiB` на транскрипт) и защитой от зависаний (таймауты 5с / 25с, coalesce-обновления только на границах коммитов).
3. **Строгая проекция истории без утечек thinking (`src/history/`):** Полная трансляция цепочки сообщений и вызовов инструментов в контракт истории BB (`HistoricalSnapshot`). Блоки `thinking` и их криптографические подписи гарантированно фильтруются и выводятся в аудит-список `omissions`, исключая попадание сырых рассуждений в публичный чат.
4. **Тонкие фиксы раннера и моста (`runner/bridge`, `host/paths.ts`):** 
   - `message_end flush` в `bb-child-event-adapter.ts`: принудительный досыл потерянных текстовых дельт при завершении стриминга.
   - `runner-lookup.ts`: безошибочное определение рабочего `dataDir` из пути артефакта (`plugin-host-artifacts/<pluginId>/<digest>/host.mjs`), предотвращающее подхват чужого раннера из глобальной папки `~/.bb`.
   - Вшивание версии манифеста в бандл на этапе сборки.
5. **Двойственная природа адаптера (Граница Thin Bridge Invariant):**
   - **Чистое золото:** Механизмы расчета CoherentOutcome, санитизация thinking, `message_end flush`, TaskGraph -> PlanSteps трансляция, лимиты буферов и алгоритм поиска раннера.
   - **Инвазивный оверинжиниринг:** Патчинг бинарников BB Core (`candidates/parallel-bb-core`), добавление несуществующих в стандартном SDK реверс-RPC методов (`thread/registerExisting`, `thread/reconcileExisting`, `thread/getOwnerScope`), и тяжелая система криптографических профилей оператора (`operator-profile*.ts`), привязанная к Unix `chmod 0700` и `getuid()`.

---

## 2. Глубокий анализ компонентов

### 2.1. Outcome: Определение CoherentOutcome и разрешение статусов задач
**Файлы:** `src/outcome/coherent.ts`, `src/outcome/resolver.ts`

#### Архитектурный принцип:
Статус выполнения задачи (completed, failed, interrupted, working) принадлежит **квитанции последнего нативного ввода** (`SubmissionRecord`), а не первичному спавну, форме отчета Courier/Reporter, тексту ответа или флагу `stopReason`.

#### Механизм `resolveRequestOutcome`:
Функция в `src/outcome/resolver.ts` принимает целевой контекст `OutcomeTarget` (`conversationId`, `parentConversationId`, `anchorTaskId`, `requestId`), записи рантайма `OutcomeRecords` (`conversation`, `submission`) и опциональное текущее состояние наблюдения `SnapshotEvent`:
1. **Проверка подлинности владельца (Owner-mismatch guard):**
   ```typescript
   if (conversation.id !== target.conversationId || 
       conversation.owner?.conversationId !== target.parentConversationId || 
       conversation.owner.taskId !== target.anchorTaskId) {
       return { status: 'unknown', reason: 'owner-mismatch' };
   }
   ```
   Это полностью исключает спуфинг чужих или осиротевших задач.
2. **Проверка активности в реальном времени:**
   Если `observed?.run` активен или очередь `observed?.inbox.length > 0`, статус **безусловно** выставляется в `working` (reason: `'observed-active'`).
3. **Детерминированный маппинг Durable Submission:**
   - `submission.status === 'queued' | 'placed'` $\rightarrow$ `status: 'working'`.
   - `submission.status === 'done'` $\rightarrow$ `status: 'completed'`, возвращается `submissionId` и `answer`.
   - `submission.reason === 'aborted' | 'reset'` $\rightarrow$ `status: 'interrupted'`.
   - `submission.reason === 'model_error' | 'no_model' | 'faulted'` $\rightarrow$ `status: 'failed'`.
   - Любые недокументированные причины переходят в `status: 'unknown', reason: 'unsupported-reason'` (fail-closed подход, никаких догадок).

#### Механизм `readCoherentOutcome` (Two-Phase OCC):
Для исключения состояния гонки (race condition) чтение выполняется в две фазы с фиксацией слепка скоупа:
1. `selected = await selection()`: считывается `ChildBindingDoc`, `SubagentsDoc`, `TeamDoc` и формируется ревизия `JSON.stringify([target, executions.map(e => e.requestId).sort()])`.
2. Запрашивается история `read.readOutcomeHistory(child, pendingRequestIds, context)`.
3. `current = await selection()`: повторный срез. Если `current.revision !== selected.revision`, возвращается `{ status: 'unknown', reason: 'execution-changed' }`.
4. Если `!frame.stable` $\rightarrow$ `'concurrent-change'`. Если `frame.truncated` $\rightarrow$ `'history-receipt-mismatch-or-unsupported'`.
5. Валидация целостности:
   - Последнее сообщение пользователя в транскрипте (`latestUser`) обязано иметь ID, равный `receipt.entry`.
   - Ответ ассистента (`answer`) обязан быть записью `AssistantEntry` и иметь ID строго больше ID пользовательского ввода (`Number(answer.id) > Number(receipt.entry)`).

---

### 2.2. Native Controls & Observation
**Файлы:** `src/native/child-scope.ts`, `child-control.ts`, `child-observation.ts`, `child-title.ts`, `native-pair.ts`

#### Scope & Identity (`child-scope.ts`):
Проверяет инвариант связки: `ChildBindingDoc.parent` $\rightarrow$ `SubagentsDoc.agents[key]` $\rightarrow$ `TeamDoc.executions`. Все идентификаторы `requestId` в execution-списке должны быть строго уникальны, а один из них обязан совпадать с `record.requestId`.

#### Child Control (`child-control.ts`):
Поддерживает три команды: `prompt`, `steer`, `abort`:
1. **Инвариант потерянного подтверждения (Lost ACK Invariant):**
   Потерянный сетевой пакет ACK никогда не вызывает автоматический повтор запроса. Дедупликация гарантируется детерминированными `requestId` на уровне SDK.
2. **Лимиты буферов:**
   - Размер текста сообщения строго ограничен: `Buffer.byteLength(command.message) <= 512 * 1024` (512 KiB).
   - Длина `requestId`: $\le 256$ символов.
3. **Защита целей (Goal Protection):**
   Перед выполнением `abort` проверяется `goals.protectsExecution(conversation.id)`. Если задача защищена инвариантом цели, операция прерывания отклоняется с `CHILD_CONTROL_GOAL_PROTECTED`.

#### Child Observation Service (`child-observation.ts`):
Предоставляет приватный IPC-сервер для потоковой передачи событий и статусов:
1. **Безопасность сокета и атомарный линк:**
   - Сокет слушается во временной приватной папке (`mkdtemp`, права `0700`, сокет `0600`, проверка `uid === process.getuid()`).
   - Используется техника жесткой ссылки (`link(internalPath, socketPath)`): Node.js при закрытии сокета удаляет путь прослушивания; использование линка гарантирует, что случайный re-bind или закрытие никогда не удалит замещающий файл.
2. **Лимиты пропускной способности и защита от DoS:**
   - Максимум параллельных соединений: `MAX_CONNECTIONS = 8`.
   - Лимит входящего фрейма: `MAX_FRAME_BYTES = 1024 * 1024` (1 MiB).
   - Лимит исходящего фрейма/ответа: `MAX_OUTPUT_BYTES = 8 * 1024 * 1024` (8 MiB).
   - Таймауты: 5000 мс на базовые операции и запись кадра (`TIMEOUT_MS`), 25000 мс на спаривание (`PAIR_TIMEOUT_MS`).
3. **Коалесцирование обновлений (Coalesced Outcome Refresh):**
   Вместо накопления бесконечной очереди истории событий реализован coalescing через булевый флаг `outcomeDirty`. Обновление outcome вызывается **только на границах коммитов** (`snapshot`, `run_start`, `run_end`, `message_end`, `tool_execution_start`, `tool_execution_end`), полностью игнорируя промежуточные дельты генерации токенов.

---

### 2.3. History: Проекция и синхронизация истории
**Файлы:** `src/history/history-projector.ts`, `history-sink.ts`, `observation-client.ts`

#### Проекция истории (`history-projector.ts`):
Преобразует `SnapshotEvent` или `CoherentOutcome` в каноническую структуру `HistoricalSnapshot`:
1. **Защита от утечек рассуждений (Thinking Redaction):**
   ```typescript
   if (omissions && role === 'assistant' && block.type === 'thinking') {
       // Public SDK ThinkingContent: never copy opaque thinking/signatures into
       // chat, accounting or errors; unfamiliar payload shapes still fail closed.
       omissions.push({ source, kind: 'thinking' });
       continue;
   }
   ```
   Блоки `thinking` и подписи `thinkingSignature` отбрасываются из чата, но регистрируются в объекте аудита `omissions: readonly ThinkingOmission[]`.
2. **Связывание вызовов тулов (Tool Call Coupling):**
   - Вызовы `toolCall` сохраняются в мапе `pendingTools`.
   - Результаты из `pi.tool-result` находят соответствующий вызов по `toolCallId`.
   - Если статус транскрипта `completed`, но в `pendingTools` остался незавершенный вызов, генерация признается невалидной (`unsettled tool call`) и выбрасывает ошибку (fail-closed).
3. **Изоляция системных сообщений:**
   Системные служебные сообщения `pi.system` нормализуются в пустое позиционное сообщение, не засоряя чат BB.

#### History Sink (`history-sink.ts`):
Реализует протокол Compare-And-Swap (CAS) для отправки снимка истории в BB:
1. `openHistorySink` запрашивает начальный `expectedDigest` у хоста BB.
2. Перед отправкой нового снимка проверяется отсутствие параллельного вызова (`busy: boolean`).
3. При сбое сетевого подтверждения (unacknowledged apply) синк переходит в защитное состояние («замораживается»), запрещая отправку новых снимков и разрешая **только повтор идентичного payload**.

---

### 2.4. Runner & Host Bridge
**Файлы:** `src/provider/runner/bridge/`, `src/provider/host/runner-lookup.ts`, `paths.ts`, `installation-manager.ts`

#### Ключевые багфиксы и улучшения:
1. **`message_end flush` (`bb-child-event-adapter.ts`):**
   В обработчик события `message_end` добавлена проверка хвостовой дельты:
   ```typescript
   case "message_end": {
       this.closeThinkingIfNeeded();
       const message = event.entry?.model?.[0];
       if (message?.role === "assistant") {
           const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
           const delta = text.startsWith(this.currentText) ? text.slice(this.currentText.length) : text;
           if (delta) this.output({ 
               type: "message_update",
               assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta }, 
               parentRef: this.parentRef,
               ...(this.conversationId !== undefined ? { conversationId: this.conversationId } : {}) 
           });
           this.currentText = "";
           this.currentThinking = "";
       }
       break;
   }
   ```
   Если дельта стриминга была потеряна или оборвана, в момент закрытия сообщения остаток текста гарантированно отправляется в BB.
2. **Безопасный поиск Runner в деплой-структуре BB (`runner-lookup.ts`, `paths.ts`):**
   BB деплоит бандлы в `<dataDir>/plugin-host-artifacts/<pluginId>/<digest>/host.mjs`. Функция `dataDirFromHostArtifact` восстанавливает точный `dataDir` из пути исполняемого бандла. Это предотвращает критическую ошибку, когда запущенный из кастомной директории хост случайно подхватывал раннер из глобальной `~/.bb`.
3. **Вшивание версии манифеста (`installation-manager.ts`):**
   Импорт `manifest from "../../../package.json" with { type: "json" }` вшивает версию плагина внутрь скомпилированного бандла, исключая падение при отсутствии `package.json` рядом с `host.mjs` в рантайме.
4. **Защита общего хоста от ложного abort (`runner-process.ts`):**
   При наличии флага `sharedHost` клиентское закрытие вкладки BB не посылает `abort` на процесс раннера, сохраняя терминальную сессию живой.

---

### 2.5. Тестовая база и регрессионное покрытие
**Файлы:** `tests/provider/`, `tests/packaging/`

1. **`task-graph-bridge.test.ts`:**
   - Проверка порядка шагов: генерация $\rightarrow$ вызов тула $\rightarrow$ компактизация.
   - Дедупликация: неизменившийся граф задач не генерирует повторные события в шину BB.
   - Форматирование: имена тулов с аргументами форматируются в 1 строку длиной до 48 символов с эллипсисом (`…`).
2. **`shared-host.test.ts`:**
   - Подключение двух клиентов к одному экземпляру хоста с базой SQLite.
   - Проверка подключения «позднего клиента» (late attach) через replay снимка.
   - Проверка отсутствия дублирования выполнения (`executions === 1`).
   - Изоляция по рабочим директориям (CWD mismatch приводит к немедленному отклонению).
3. **`classic-bridge-disabled.test.ts`:**
   - Гарантирует, что при инициализации Durable раннера классические расширения Pi (из `~/.pi/agent/extensions`) принудительно отключены (`noExtensions: true`), исключая двойной запуск инструментов и утечку памяти.
4. **`child-outcome.test.mjs`, `child-history.test.mjs`:**
   - Проверка, что естественный ответ модели или валидный JSON не распознается ошибочно как внутренний служебный `ChildReport`.
   - Проверка изоляции ошибок: ошибка в одном туле не ломает весь снимок истории.

---

## 3. Анализ Thin Bridge Invariant: Золото vs Оверинжиниринг

Плагин `bb-plugin-provider-pi-durable` по своей архитектуре должен оставаться **тонким мостом (Thin Bridge)** между BB Plugin SDK и Pi Durable Runtime. Любое расширение должно соответствовать официальным контрактам и не требовать модификации ядра самого редактора BB.

### 3.1. Инвазивный оверинжиниринг (Категорически отбросить)

1. **Патчинг бинарников BB Core (`candidates/parallel-bb-core`):**
   - **Что сделано в diffuzmetall:** Автор модифицировал исходный код BB (`apps/server`, `apps/host-daemon`, `packages/db`, `packages/agent-runtime`) и добавил кастомные RPC-методы:
     - `thread/registerExisting`
     - `thread/reconcileExisting`
     - `thread/getOwnerScope`
     - `thread/confirmRootAttachment`
   - **Почему это неприемлемо:** В стандартном релизе BB IDE и BB Plugin SDK этих методов **не существует**. Если наш плагин начнет вызывать `thread/reconcileExisting`, стандартный BB вернет ошибку `Method not found (-32601)` либо сессия зависнет по таймауту 10 секунд.
   - **Решение:** ОТБРОСИТЬ. Проекция дочерних задач обязана использовать стандартные механизмы BB Plugin SDK (`ThreadDelta`, `planSteps`, спавн через SDK).
2. **Сложная система Operator Profiles (`operator-profile*.ts`, `provider-grant.ts`):**
   - Тяжелый слой криптографических отпечатков, профилей оператора и взаимной авторизации файлов на диске. Создан для закрытого окружения Pocket/Dolt. Для открытого плагина это избыточный мертвый код.
   - **Решение:** ОТБРОСИТЬ.
3. **Unix-специфичные проверки прав файловой системы:**
   - Использование `process.getuid?.()`, битовых масок `(directory.mode & 0o7777) !== 0o700` и `0o600`.
   - На Windows (включая сценарии запуска BB через Bootya/WSL/Windows Host) `process.getuid` равен `undefined`, а файловые атрибуты не соответствуют POSIX-маскам, что приведет к исключениям `PRIVATE_SOCKET_PARENT_REQUIRED`.
   - **Решение:** ОТБРОСИТЬ прямую привязку к POSIX-правам в кроссплатформенном коде.

---

### 3.2. Матрица применимости компонентов

| Компонент | Источник | Ценность | Соответствие Thin Bridge | Решение |
| :--- | :--- | :--- | :--- | :--- |
| **Coherent Outcome & Resolver** | `outcome/coherent.ts`, `resolver.ts` | **Критическая** (исключает эвристики и гонки статусов) | **Высокое** (работает чисто на данных Pi Durable Tx/Submission) | **БРАТЬ** (адаптировать под структуры `bb-plugin-provider-pi-durable`) |
| **Message End Flush** | `bb-child-event-adapter.ts` | **Высокая** (страховка от потери текста при обрыве дельт) | **Полное** (локальный фикс адаптера) | **БРАТЬ** (перенести в runner bridge) |
| **Thinking Redaction** | `history/history-projector.ts` | **Высокая** (защита от утечки скрытых рассуждений в чат) | **Полное** (фильтрация на уровне представления) | **БРАТЬ** (встроить в транслятор) |
| **Buffer Limits & Timeouts** | `native/child-control.ts`, `child-observation.ts` | **Высокая** (512 KiB ввод, 8 MiB вывод, таймауты 5с/25с) | **Полное** (защита от OOM и зависаний) | **БРАТЬ** |
| **Task Graph -> PlanSteps Bridge** | `task-graph-bridge.ts`, `task-labels.ts` | **Высокая** (нативный UI-план задач в панели BB) | **Полное** (использует официальный `planStepsPresentation`) | **БРАТЬ** |
| **Safe Runner Lookup** | `runner-lookup.ts`, `paths.ts` | **Высокая** (защита от подхвата чужого раннера из `~/.bb`) | **Полное** (устраняет дефект рендеринга путей) | **БРАТЬ** |
| **Bundled Version in Manifest** | `installation-manager.ts` | **Средняя** (надежный fallback версии) | **Полное** | **БРАТЬ** |
| **Reverse RPC to Core (`reconcileExisting`)** | `history-sink.ts`, `bridge.ts` | **Отрицательная** (ломает стандартный BB) | **Нарушает** (требует патченый Core) | **ОТБРОСИТЬ** |
| **Operator Profiles / Grants** | `bootstrap/operator-profile*.ts` | **Низкая** (оверинжиниринг под Pocket) | **Нарушает** (раздувает кодовую базу) | **ОТБРОСИТЬ** |
| **POSIX UID / Mode checks** | `child-observation.ts`, `native-pair.ts` | **Низкая** (ломает совместимость с Windows) | **Ограниченное** | **МОДИФИЦИРОВАТЬ** (сделать no-op на non-POSIX) |

---

## 4. Конкретные рекомендации для Cycle 93

На основе проведенного аудита рекомендуется сформировать следующий скоуп задач для реализации в Cycle 93:

### Шаг 1. Перенос ядра детерминированного Outcome (`Outcome Layer`)
- Адаптировать `src/outcome/resolver.ts` и `src/outcome/coherent.ts` в `src/runner/outcome/` (или `src/host/outcome/`).
- Заменить любые проверки завершения задач по тексту/stopReason на `resolveRequestOutcome`.
- Обеспечить двухфазную проверку ревизий перед фиксацией терминального состояния.

### Шаг 2. Внедрение `message_end flush` в Bridge
- Обновить `src/runner/bridge/bb-child-event-adapter.ts` и `bb-event-adapter.ts`, добавив проверку и досыл остатка текстовой дельты (`delta = text.startsWith(this.currentText) ? ...`) перед очисткой буферов.

### Шаг 3. Интеграция безопасного обнаружения раннера (`Runner Lookup`)
- Перенести логику из `runner-lookup.ts` в `src/host/paths.ts`.
- Использовать `dataDirFromHostArtifact` для детерминированного вычисления корня данных BB из пути запущенного бандла.
- Вшить импорт версии из `package.json` в `installation-manager.ts`.

### Шаг 4. Санитизация и фильтрация Thinking блоков
- Внедрить проверку типов блоков ассистента в трансляторах сообщений: если блок имеет тип `thinking` или атрибут `thinkingSignature`, исключать его из текстового потока чата BB и направлять в служебную телеметрию/лог.

### Шаг 5. Стабилизация буферов и тайм-аутов IPC
- Ввести константы лимитов в контроллеры:
  - Максимальный размер пользовательского ввода: `512 KiB`.
  - Максимальный размер кадра: `1 MiB`.
  - Максимальный размер истории: `8 MiB`.
  - Таймаут операций управления: `5 000 мс`.

### Шаг 6. Расширение тестового покрытия
- Адаптировать тесты `task-graph-bridge.test.ts`, `classic-bridge-disabled.test.ts` и параметризованные тесты резолвера `child-outcome.test.mjs` в тестовую базу `tests/`.
