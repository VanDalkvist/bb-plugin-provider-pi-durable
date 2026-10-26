# Архитектурное ревью: Runtime Graph Backend (G1/G2) и Session Admission Race

**Дата:** 2026-10-26  
**Проект:** `/Users/vanya/Projects/bb-plugin-provider-pi-durable`  
**Исполнитель:** Независимый технический worker (профиль: configured antigravity/gemini-3.8-flash/high, revision 3)  
**Режим:** Read-only аудит рабочего дерева. Код, версии и зависимости не изменялись.  
**Предмет аудита:**
1. Backend Runtime Task Graph (срезы G1.1, G1.2, G2) по планам `docs/superpowers/plans/2026-10-25-runtime-task-graph.md`, `docs/superpowers/plans/2026-10-26-runtime-graph-backend-slice.md` и отчёту `runtime-graph-backend-result.md`.
2. Исправление дефекта гонки допуска сессий по плану `docs/superpowers/plans/2026-10-26-admission-race-slice-plan.md` и отчёту `admission-race-result.md`.
3. Соответствие архитектурным правилам `arch-rules.md` (AP-010 – AP-071), `arch-improvement-review/SKILL.md`, `arch-rules-implementation-review/SKILL.md` и инвариантам репозитория в `AGENTS.md`.

---

## 1. Резюме аудита и Вердикт

В рабочем дереве выполнена значительная работа по проектированию контрактов (Zod-схемы, типизация DTO, координатор допуска `SessionAdmissionCoordinator`, сохранение бюджетов строк AP-019 во всех 24 файлах, 0 циклических зависимостей по AP-025, 493 проходящих теста).

Однако детальный статический анализ исходных кодов выявил **критические расхождения между декларируемым и фактическим поведением рантайма**:
1. **[P1] Фальсификация статусов completed задач:** При исчезновении узла из живого графа (`view.tasks`) он безусловно записывается в квитанции как `outcome: "orphaned"`. В реальном коде раннера вызов `recordTerminal` никогда не вызывается и не подключён к `harness.getTask()` или событиям коммита, из-за чего **любая успешно завершённая задача в рантайме объявляется "осиротевшей" (orphaned)**.
2. **[P1] Разрешение ожидающих промисов с убитым процессом runner:** При прерывании создания сессии (`admission.aborted = true`) координатор вызывает `release` вместо `reject`. В результате все параллельные ожидающие клиенты (`turn/start`, дочерние треды) получают ссылку на принудительно убитый процесс runner и падают с ошибками RPC при первом обращении.
3. **[P1] Аварийное завершение shared root owner при остановке дочернего треда:** `SessionAdmissionCoordinator.abort(threadId)` убивает сессию целиком, даже если `threadId` был лишь дочерней беседой (алиасом), уничтожая процесс корневой сессии. Обратно: если дочерний тред был в режиме ожидания (`wait`), он не регистрируется в `byThreadId` и после старта родителя утекает в активные сессии, несмотря на вызов `stop()`.
4. **[P1] Несовместимость Zod-схемы с браузерным окружением UI:** В `schema.ts` (импортируемом в UI-модуль `read.ts`) валидация 1 MiB использует глобальный Node.js `Buffer.byteLength`. В браузере/десктопном WebView BB `Buffer` не определён, блок `catch` перехватывает `ReferenceError` и возвращает `false`, ломая чтение любого валидного снимка на клиенте.
5. **[P2] Полная неработоспособность дедупликации снимков:** Мутация `revision` и `observedAt` происходит *до* проверки сериализованного JSON, из-за чего `serialized === this.lastPublishedJson` всегда `false`, порождая спам дельтами в шину BB на любое обновление view.
6. **[P2] Дочерние субтреды BB не получают снимки графа:** Событие `runtime_graph_snapshot` не содержит `conversationId` и транслируется только на родительский `threadId`. Скоупинг дочерних графов в живом рантайме отключён.
7. **[P2] Потеря дерева владения беседами:** Поле `conversations` собирается исключительно из текущих живых узлов; после завершения задачи-создателя метаданные владения дочерней беседой безвозвратно теряются.

**ИТОГОВЫЙ ВЕРДИКТ: FAIL** (наличие 4 блокирующих дефектов P1 и 4 дефектов P2).

---

## 2. Строгие дефекты (Findings)

### [P1] Missing receipt != authoritative orphaned: Все завершённые задачи фальсифицируются как "orphaned"
- **Evidence:**  
  - `src/runner/runtime-graph-receipts.ts:84-98`:
    ```ts
    reconcileDisappearedNode(info: DisappearedNodeInfo): RuntimeTaskReceipt {
        const receipt: RuntimeTaskReceipt = {
            taskId: info.taskId,
            conversationId: info.conversationId,
            kind: info.kind,
            outcome: "orphaned",
            error: {
                message: "Node disappeared from active graph before terminal receipt was observed",
                code: "RECONCILED_WITHOUT_RECEIPT",
            },
            endedAt: info.disappearedAt,
        };
        this.pushReceipt(receipt);
        return receipt;
    }
    ```
  - `src/runner/runtime-graph-source.ts:187-198`:
    ```ts
    private reconcileDisappearedNodes(currentLiveIds: Set<number>): void {
        for (const [prevId, prevInfo] of this.previousNodes) {
            if (!currentLiveIds.has(prevId) && !this.receipts.hasReceipt(prevId)) {
                this.receipts.reconcileDisappearedNode({
                    taskId: prevId,
                    conversationId: prevInfo.conversationId,
                    kind: prevInfo.kind,
                    disappearedAt: this.clock(),
                });
            }
        }
    }
    ```
  - `src/runner/index.ts:172-178`: `RuntimeGraphSource` инициализируется исключительно от `durable.view`. Метод `recordTerminal` не вызывается ни в одном рабочем файле рантайма (только в юнит-тестах). Вызовы `harness.getTask()`, `scanTasks()` или обработчики завершения коммитов отсутствуют в кодовой базе.
- **Impact:** В Pi Durable живой граф `view.current().tasks` содержит только незавершённые задачи (`pending`, `running`, `waiting`, `sleeping`, `completing`). Как только задача завершается (успешно выполнилась, вернула результат), она естественным образом исчезает из `view.current().tasks`. Поскольку `recordTerminal` никогда не вызывается из реального рантайма, метод `reconcileDisappearedNodes` помечает **каждую нормально завершённую задачу** как `outcome: "orphaned"` с кодом `RECONCILED_WITHOUT_RECEIPT`. В UI и клиенте все успешные шаги навсегда получают статус "Осиротевшая задача" с ошибкой.
- **Rule:** AP-013 (Целостность пользовательских данных), AP-050 (Справочные данные, статусы и перечисления как контракты), AP-012 (Fail-fast и явные контракты ошибок).
- **Fix decision:** `fix-now` (подключить авторитетное получение квитанций через чтение записей задач `harness.getTask()` / подписку на завершение задач, вместо фальсификации статуса `orphaned`).

---

### [P1] Аборт in-flight сессии резолвит ожидающие запросы с убитым процессом runner
- **Evidence:**  
  - `src/host/session-registry.ts:136-139`:
    ```ts
    if (admission.aborted) {
        session.kill();
        this.admission.release(admission, session);
        throw new Error("SESSION_CREATION_ABORTED");
    }
    ```
  - `src/host/session-registry.ts:163-167`:
    ```ts
    if (admission.aborted) {
        session.kill();
        this.admission.release(admission, session);
        throw new Error("SESSION_CREATION_ABORTED");
    }
    ```
  - `src/host/session-admission.ts:57-60`:
    ```ts
    public release(admission: InFlightAdmission, session: OwnedSessionPort): void {
        this.cleanup(admission);
        admission.resolve(session);
    }
    ```
- **Impact:** Если создание сессии было прервано (например, вызов `stop()` во время `await session.start()`), сессия принудительно убивается через `session.kill()`. Однако строки 138 и 165 вызывают `this.admission.release(admission, session)`! Метод `release` успешно резолвит общий промис `admission.promise`. Все параллельные клиенты (`turn/start`, дочерние субтреды), ожидавшие этот промис, получают инстанс **мертвого убитого раннера**, ошибочно считают создание успешным и при попытке отправить команду падают с ошибками протокола/разрыва процесса (`-32000 Runner exited`).
- **Rule:** AP-034 (Явная стратегия конкурентного доступа), AP-012 (Fail-fast и явные контракты ошибок), AP-023 (Async дисциплина).
- **Fix decision:** `fix-now` (при `admission.aborted` вызывать `this.admission.reject(admission, new Error("SESSION_CREATION_ABORTED"))`, а не `release`).

---

### [P1] Остановка дочернего треда-официанта убивает корневой процесс, либо оставляет остановленный тред зарегистрированным
- **Evidence:**  
  - `src/host/session-registry.ts:179-187`:
    ```ts
    public async stop(threadId: string): Promise<void> {
        this.admission.abort(threadId);
        const session = this.sessions.get(threadId);
        ...
    }
    ```
  - `src/host/session-admission.ts:69-77`:
    ```ts
    public abort(threadId: string): void {
        const admission = this.byThreadId.get(threadId);
        if (admission) {
            admission.aborted = true;
            if (admission.session) {
                try { admission.session.kill(); } catch {}
            }
        }
    }
    ```
  - `src/host/session-admission.ts:25-34`: В методе `acquire` клиенты ветки `kind: "wait"` **не добавляются** в `this.byThreadId`.
- **Impact:**
  1. Если дочерний тред инициировал создание (`nativeChild.isNative`), `byThreadId` хранит и `childThreadId`, и `parentThreadId`. Вызов `stop(childThreadId)` ставит `admission.aborted = true` и вызывает `session.kill()`, убивая родительский runner-процесс всей сессии.
  2. Если родительский тред инициировал создание, а дочерний тред ожидает (`wait`), `childThreadId` вообще отсутствует в `byThreadId`. Вызов `stop(childThreadId)` не прерывает ожидание дочернего треда. После старта родителя дочерний тред продолжает выполнение, вызывает `attachShared` и регистрируется в `this.sessions`, несмотря на то, что был остановлен.
- **Rule:** AP-034 (Явная стратегия конкурентного доступа), AP-027 (Конфигурация и teardown), AP-013 (Целостность данных).
- **Fix decision:** `fix-now` (разграничить отмену владения процессом и отмену отдельного дочернего официанта: отмена дочернего ожидания не должна приводить к вызову `session.kill()` корневой сессии).

---

### [P1] Использование Node.js `Buffer.byteLength` в Zod-схеме ломает клиентскую валидацию в UI/браузере
- **Evidence:**  
  - `src/runtime-graph/schema.ts:125-134`:
    ```ts
    .refine(
        (snapshot) => {
            try {
                const json = JSON.stringify(snapshot);
                return Buffer.byteLength(json, "utf8") <= MAX_SNAPSHOT_BYTES;
            } catch {
                return false;
            }
        },
        { message: "Runtime graph snapshot exceeds 1 MiB payload limit" },
    )
    ```
  - `src/ui/runtime-graph/read.ts:2`: импортирует `runtimeGraphSnapshotSchema` из `schema.ts`.
- **Impact:** Модуль `src/ui/runtime-graph/read.ts` предназначен для исполнения в среде UI-плагина Beyond Boundaries (браузерный JS / Electron renderer). В браузере глобальный объект `Buffer` отсутствует (ReferenceError). Блок `catch` ловит эту ошибку и безусловно возвращает `false`. В результате валидация любого корректного снимка в `readRuntimeGraphSnapshot` всегда завершается ошибкой "Runtime graph snapshot exceeds 1 MiB payload limit", возвращая статус `unavailable`.
- **Rule:** AP-026 (API-контракты и DTO границы), AP-051 (Frontend feature boundaries), AP-066 (TypeScript / совместимость сред).
- **Fix decision:** `fix-now` (заменить на `typeof Buffer !== "undefined" ? Buffer.byteLength(json, "utf8") : new TextEncoder().encode(json).length`).

---

### [P2] Неработающая дедупликация снимков в `RuntimeGraphSource` из-за опережающей мутации revision
- **Evidence:**  
  - `src/runner/runtime-graph-source.ts:166-184`:
    ```ts
    const snapshot: RuntimeGraphSnapshot = {
        version: 1,
        scope: this.scope,
        observation: {
            epoch: this.epoch,
            revision: ++this.revision,
            observedAt: this.clock(),
            completeness,
        },
        nodes: mappedNodes,
        conversations,
        receipts,
        stats: { ... },
    };

    const serialized = JSON.stringify(snapshot);
    if (serialized === this.lastPublishedJson) return;
    this.lastPublishedJson = serialized;
    ```
- **Impact:** Инкремент `++this.revision` и вызов `this.clock()` выполняются *до* сериализации и сравнения с `this.lastPublishedJson`. Поскольку ревизия увеличивается на каждый вызов `publish()`, условие `serialized === this.lastPublishedJson` **всегда ложно**. Любое стороннее изменение во view (например, обновление `pi.agent` или `context`) вызывает публикацию нового снимка и генерацию дельты `extension.state` в Beyond Boundaries, нарушая контракт ограничения частоты и сброса неизменных снимков.
- **Rule:** AP-045 (Защита от злоупотреблений и resource exhaustion), AP-018 (Ясность и одна ответственность).
- **Fix decision:** `fix-now` (сравнивать хеш/JSON значащих данных — `nodes`, `conversations`, `receipts`, `completeness` — до инкремента ревизии; если данные не изменились, выходить без публикации).

---

### [P2] Дочерние субтреды Beyond Boundaries не получают scoped `runtime_graph_snapshot` дельты
- **Evidence:**  
  - `src/runner/index.ts:177`:
    ```ts
    activeGraphSource.subscribe((snapshot) => output({ type: "runtime_graph_snapshot", snapshot }));
    ```
    Событие отправляется без указания `conversationId`.
  - `src/host/session.ts:124-129`: событие транслируется и отсылается только в `this.options.threadId` (родительский тред).
  - `src/host/session-subagent-handler.ts:105-110`: не распознаёт событие как дочернее (так как `event.conversationId` не задан) и не маршрутизирует его зарегистрированным дочерним субтредам.
  - `src/host/delta-translator.ts:153`: `translateRuntimeGraphSnapshot(event)` вызывается без передачи `targetConversationId`.
- **Impact:** Несмотря на наличие функции `filterSnapshotForConversation`, в живом хосте плагина она никогда не вызывается для дочерних тредов. Дочерние субтреды Beyond Boundaries никогда не получают дельты `thread/extensionState/updated` для своего скоупа; граф обновляется только на корневом треде.
- **Rule:** AP-026 (API-контракты и DTO границы), AP-048 (Явное соответствие идентификаторов).
- **Fix decision:** `fix-now` (при получении `runtime_graph_snapshot` в сессии рассылать отфильтрованные снимки всем активным зарегистрированным дочерним субтредам).

---

### [P2] Пересборка `conversations` только из live-узлов приводит к потере иерархии после завершения задач
- **Evidence:**  
  - `src/runner/runtime-graph-source.ts:128-146`:
    ```ts
    const conversations: Record<string, RuntimeConversationNode> = {
        [this.scope.rootConversationId]: { id: Number(this.scope.rootConversationId) },
    };
    for (const [key, node] of liveNodeEntries) {
        ...
        for (const ownedConvId of node.conversations ?? []) {
            const cid = Number(ownedConvId);
            conversations[String(cid)] = {
                id: cid,
                owner: { conversationId: convId, taskId: id },
            };
        }
    }
    ```
- **Impact:** Словарь `conversations` инициализируется заново при каждом вызове `publish()` и наполняется исключительно ссылками `node.conversations` из текущих *живых* задач. Как только задача, породившая дочернюю беседу (например, делегирование субагенту), переходит в терминальный статус и выбывает из `liveNodeEntries`, связь владения `{ conversationId, taskId }` исчезает из графа. При последующих фильтрациях `filterSnapshotForConversation` для дочерней беседы или её потомков цепочка владения не может быть восстановлена, и задачи дочерней беседы выпадают из видимости.
- **Rule:** AP-013 (Целостность данных), AP-038 (Сквозной контекст запроса и traceability).
- **Fix decision:** `fix-now` (накапливать и сохранять известные связи бесед между публикациями, либо читать их из постоянного реестра бесед `ConversationRecord`).

---

### [P2] `createOrGet` возвращает существующую сессию без проверки соответствия `providerThreadId` и `sessionKey`
- **Evidence:**  
  - `src/host/session-registry.ts:66`:
    ```ts
    const existing = this.sessions.get(threadId);
    if (existing && !existing.runner?.exited) return existing;
    ```
- **Impact:** Если метод `createOrGet` вызван с существующим `threadId`, но с другим `providerThreadId` (указывающим на другой `sessionKey` или другую директорию SQLite), метод возвращает прежнюю сессию без проверки идентичности сессионного ключа. Аналогично в строках 76-88 сессия родительского треда берется без проверки совпадения `sessionKey`.
- **Rule:** AP-039 (Auth boundary и доверенная идентичность), AP-048 (Явное соответствие идентификаторов).
- **Fix decision:** `fix-now` (добавить валидацию: если `sessionKey` запроса не совпадает с `sessionKey` найденной сессии, выбрасывать типизированную ошибку несовпадения идентичности).

---

## 3. Разграничение проверенных контрактов и непроверенного Live Seam

Необходимо строго различать модульные контракты и живой транспорт Beyond Boundaries:

1. **Проверено детерминированно в коде и тестах:**
   - Форматы DTO и Zod-схемы (`runtimeGraphSnapshotSchema`), лимиты (512 live-узлов, 128 квитанций, длины строк).
   - Чистые функции проекции статусов: `completing` сохраняет `isFinal: false`, `isCompleting: true`; `abortRequested` является флагом; ошибка инструмента `isToolError` не затирает статус задачи.
   - Сериализация допуска: одновременные вызовы `thread/start` и `turn/start` на одном `threadId` объединяются в одну сессию и не порождают второй процесс runner (регрессионный тест воспроизведения P1 проходит стабильно).
   - Лимиты строк AP-019 (< 200 строк) соблюдены во всех файлах.
   - Граф импортов AP-025 строго ацикличен (0 циклов).

2. **Непроверенный Live Seam (Архитектурный риск):**
   - **Живой раундтрип сохранения `extension.state` в БД Beyond Boundaries:** Тесты `runtime-graph-bridge.test.ts`, `runtime-graph-public-events.test.ts` и `runtime-graph-reconnect.test.ts` работают исключительно на моках (`createMockSdk`, `threadDeltaSchema.safeParse`). В реальном окружении хоста BB не подтверждено, действительно ли хост-демон BB персистит `extension.state` в события `thread/extensionState/updated`, корректно ли работает постраничная выборка `sdk.threads.events.list`, и триггерит ли это инвалидацию `thread:changed` при активных и простаивающих сессиях.
   - **Задержки и стоимость персистенции:** Нагрузочный тест всплеска 100 задач (`synthetic 100-task burst`) в реальном процессе хоста не проводился.

---

## 4. UI-Policy Gate: Контроль исключения для G3 Context Segment

В соответствии с инвариантом тонкого адаптера в `/Users/vanya/Projects/bb-plugin-provider-pi-durable/AGENTS.md`:
> ⛔ **The Thin Adapter Invariant (The Four Territories, AP-010 – AP-071).**
> Этот репозиторий — тонкий двунаправленный адаптер (GoF Adapter) между Beyond Boundaries IDE и `@earendil-works/pi-durable`.
> - Не владеть текстами промптов (извлекать динамически из `@earendil-works/pi-coding-agent`).
> - **Не изобретать свои UI-компоненты или кастомные FSM-движки.**
> - Не импортировать утекшие абстракции вне установленных портов.

### Статус и точное требуемое исключение:
- **Статус:** Реализация UI-компонентов контекстного сегмента графа задач (G3) в текущий момент **ЗАБЛОКИРОВАНА** жестким правилом репозитория `AGENTS.md` ("Не изобретать свои UI-компоненты").
- **Требуемое действие:** Агенту запрещено самостоятельно ослаблять инвариант в `AGENTS.md`. Для перехода к срезу G3 требуется явное подтверждение оператора (Вани) и внесение следующего исключения в `AGENTS.md`:
  > **Исключение для Runtime Task Graph G3:** Разрешена реализация строго read-only контекстного сегмента (`app.slots.composerContextSegment` / tree view) с использованием стандартных UI-примитивов и дизайн-токенов Beyond Boundaries (`@get-bb/plugin-sdk/app`) для визуализации реального жизненного цикла задач `@earendil-works/pi-durable`. Запрещено создание кастомных канвас-движков, сторонних FSM, интерактивных кнопок управления задачами (stop/retry/spawn) и генерации синтетических шагов плана.

---

## 5. Верификация архитектурных правил (Architecture Verification)

- **Passed:**
  - `AP-010` (Модульный монолит + Ports & Adapters): Доменная логика DTO отделена от инфраструктуры транспорта.
  - `AP-011` (Низкая связность и высокая когезия): Четкое разделение DTO, маппера, скоупа и сборщика квитанций.
  - `AP-016` (Доверенная security-граница): Секреты и токены не просачиваются в DTO графа.
  - `AP-019` (Лимиты размера и смысловое дробление): Все 24 файла строго < 200 строк.
  - `AP-020` (Clean Architecture и composition root): Композиция выполнена в `server.ts` и `src/runner/index.ts`.
  - `AP-021` (Тонкие entry points): Хэндлеры команд делегируют в специализированные модули.
  - `AP-025` (Дисциплина импортов): 0 циклических зависимостей по всему репозиторию.
  - `AP-028` (Стратегия тестирования и детерминизм): Все существующие юнит-тесты детерминированы.
  - `AP-029` (TypeScript strictness): Полная компиляция без `any` и отрицательный тест контрактов (TS2322) пройден.
- **Failed:**
  - `AP-012` (Fail-fast и явные контракты ошибок): Нарушено синтезом фиктивного статуса `orphaned` (Finding 1) и резолвом убитой сессии (Finding 2).
  - `AP-013` (Целостность пользовательских данных): Нарушено искажением статусов выполненных задач (Finding 1), удалением процесса корня при остановке дочернего треда (Finding 3) и потерей дерева бесед (Finding 7).
  - `AP-023` (Async дисциплина и no floating promises): Нарушено некорректным разрешением ожидающих промисов допуска (Finding 2).
  - `AP-026` (API-контракты и DTO границы): Нарушено использованием платформо-зависимого `Buffer` в DTO-схеме (Finding 4) и отсутствием доставки событий дочерним тредам (Finding 6).
  - `AP-027` (Конфигурация и teardown): Нарушено некорректной логикой `abort` при остановке тредов (Finding 3).
  - `AP-034` (Явная стратегия конкурентного доступа): Нарушено в обработке аборта и официантов координатора допуска (Findings 2, 3).
  - `AP-045` (Защита от злоупотреблений и resource exhaustion): Нарушено поломкой дедупликации снимков (Finding 5).
  - `AP-048` (Явное соответствие идентификаторов): Нарушено отсутствием проверки `sessionKey` в реестре (Finding 8) и отсутствием скоупинга для дочерних тредов (Finding 6).
  - `AP-050` (Справочные данные, статусы и перечисления как контракты): Нарушено подменой реального результата задачи на `orphaned` (Finding 1).
  - `AP-051` (Frontend feature boundaries): Нарушено утечкой Node.js API в клиентскую схему (Finding 4).

- **Residual risk:**
  - Непроверенность живого сохранения `extension.state` в ядре Beyond Boundaries (требует e2e верификации на работающем инстансе BB).
  - Скрытая стоимость персистенции при частых апдейтах графа.

---

## 6. Итоговый вердикт

**VERDICT: FAIL**

Переход к коммиту, релизу или реализации UI-слоя G3 блокирован до исправления находок P1 (1–4) и P2 (5–8) в рабочем дереве.
