# Повторное архитектурное ревью: Runtime Graph Backend (G1/G2) и Session Admission после исправлений

**Дата:** 2026-10-26  
**Проект:** `/Users/vanya/Projects/bb-plugin-provider-pi-durable`  
**Исполнитель:** Независимый технический worker (native subagent, configured runtime model policy)  
**Режим:** Read-only аудит рабочего дерева. Код, тесты, версии и зависимости frozen (не изменялись).  
**Нормативная база:**  
- Репозиторный `AGENTS.md` (инвариант тонкого адаптера, запрет кастомных FSM-движков/UI-компонентов, бюджет строк AP-019 < 200 строк, детерминированные тесты AP-028).  
- `~/Projects/arch-improvement-skills/skills/arch-improvement-review/SKILL.md` (критерии дефектов P0–P3, Finding Format, правила вердикта).  
- `~/Projects/arch-rules-skills/skills/arch-rules-implementation-review/SKILL.md` (архитектурная верификация AP-правил).  
- `~/Projects/arch-rules/arch-rules.md` (архитектурный baseline AP-010 – AP-071).  
- **Исторический FAIL:** `/Users/vanya/.bb/thread-storage/thr_ct3kk9xne6/s9-runtime-graph-backend.md`.  
- **Отчёты об исправлениях:** `admission-review-fixes-result.md` и `runtime-graph-review-fixes-result.md`.

---

## 1. Резюме повторного аудита и Итоговый Вердикт

В рабочем дереве проведен независимый построчный статический анализ и повторная верификация исполнения после устранения 8 дефектов (4 × P1, 4 × P2), зафиксированных в историческом отчёте `s9-runtime-graph-backend.md`.

### Ключевые результаты проверки по коду:
1. **Все 8 исторических дефектов ПОЛНОСТЬЮ ЗАКРЫТЫ** на уровне реальных исходников и подтверждены детерминированными тестами (RED → GREEN):
   - **Finding 1 (P1):** Метод `reconcileDisappearedNode` с генерацией фиктивного `outcome: "orphaned"` полностью удален из `RuntimeGraphReceiptsCollector`. Подписка на коммиты задач `harness.subscribeCommits` и чтение `harness.getTask` реально подключены в точке входа раннера (`src/runner/index.ts:167-175`). Исчезнувшие задачи без квитанции честно переводят снимок в `completeness: "limited"`, синтетический статус не выдумывается.
   - **Finding 2 (P1):** При прерывании допуска сессии (`admission.aborted = true`) координатор вызывает `reject(admission, new SessionCreationAbortedError())` вместо `release`. Все ожидающие промисы отклоняются типизированной ошибкой с кодом `SESSION_CREATION_ABORTED`; ни один клиент не получает убитый процесс runner.
   - **Finding 3 (P1):** В `SessionAdmissionCoordinator` каждый участник допуска трекается индивидуально (`AdmissionParticipant`). Остановка дочернего официанта (`stop(childThreadId)`) отменяет только его ожидание и не задевает root или других участников. Остановка дочернего создателя не убивает shared root процесс runner, пока активны root или другие официанты (`hasActive = true`). Отменённый участник не регистрируется в реестре и не шлёт дельты/identity.
   - **Finding 4 (P1):** В `src/runtime-graph/schema.ts` платформо-зависимый `Buffer.byteLength` заменен на кроссплатформенную функцию `getUtf8ByteLength` (`Buffer` → `TextEncoder` → UTF-8 loop). Браузерная клиентская валидация в UI (`src/ui/runtime-graph/read.ts`) больше не падает с `ReferenceError` при отсутствии глобального `Buffer`.
   - **Finding 5 (P2):** Дедупликация снимков в `RuntimeGraphSource` вынесена строго **ДО** инкремента `revision` и вызова часов `clock()`. Холостые тики view с неизменной структурой графа отсекаются и не спамят событиями.
   - **Finding 6 (P2):** В `src/host/session-subagent-handler.ts` реализован веерный разброс (fanout) сессионного `runtime_graph_snapshot` по всем активным дочерним субтредам с фильтрацией скоупа через `translateRuntimeGraphSnapshot(childEvent, cid)`. Корневой тред по-прежнему получает полный снимок графа.
   - **Finding 7 (P2):** Создан модуль `src/runner/runtime-graph-conversations.ts`. Известные связи бесед и метаданные владения (`owner: { conversationId, taskId }`) накапливаются персистентно и не стираются после завершения задачи-создателя.
   - **Finding 8 (P2):** В `src/host/session-registry.ts` добавлена строгая проверка идентичности `sessionKey`. При несовпадении выбрасывается типизированная ошибка `SessionIdentityMismatchError` (`SESSION_IDENTITY_MISMATCH`) без мутации существующих привязок в `this.sessions`.
2. **Качественная природа координатора допуска:**
   - Координатор допуска `SessionAdmissionCoordinator` классифицирован строго как **механизм конкурентного допуска и буккипинга участников (in-flight admission coordination & participant bookkeeping)**. В строгом соответствии с инвариантом тонкого адаптера в `AGENTS.md` ("Не изобретать свои UI-компоненты или кастомные FSM-движки") он **не является и не называется "полноценной нативной FSM"**, так как не содержит состояний переходов графа или пользовательских стейт-машин, а лишь координирует единственного создателя (Single Writer) и подписчиков на промис создания сессии.
3. **Разграничение кода и внешнего интеграционного шлюза (Capability Gate):**
   - Кодовые дефекты P0, P1, P2 отсутствуют (**0 open code defects**).
   - Сквозной раундтрип персистенции `extension.state` в локальной БД работающего хост-демона Beyond Boundaries классифицирован как **unproved live integration capability gate** (внутренние контракты и моки SDK доказаны, но внешняя БД хоста BB требует живого десктопного запуска).
   - Рендерер UI контекстного сегмента (G3) остаётся **gated** жестким правилом репозитория `AGENTS.md` ("Не изобретать свои UI-компоненты") до явного подтверждения оператора (Вани).

**ИТОГОВЫЙ ВЕРДИКТ: VERDICT: PASS** (все 8 кодовых дефектов P1/P2 закрыты, архитектурные инварианты соблюдены, внешние риски четко изолированы).

---

## 2. Статус 8 исторических находок (Findings Status)

### 1. [P1] Missing receipt != authoritative orphaned
- **Было:** Исчезновение узла из активных задач безусловно порождало квитанцию с `outcome: "orphaned"` и кодом `RECONCILED_WITHOUT_RECEIPT`. В реальном коде раннера `recordTerminal` никогда не вызывался.
- **Статус:** **CLOSED / FIXED**
- **Evidence в коде:**
  - `src/runner/runtime-graph-receipts.ts`: метод `reconcileDisappearedNode` полностью удален. Квитанции формируются исключительно через `recordTerminal(task, options)` из легитимного `TaskRecord`.
  - `src/runner/runtime-graph-source.ts:54-66`: подписка на коммиты задач:
    ```ts
    if (this.harness?.subscribeCommits) {
        this.unsubscribeCommits = this.harness.subscribeCommits((pub) => {
            for (const ch of pub.changes as Array<{ type?: string; value?: any }>) {
                if (ch?.type === "task" && (ch.value?.state?.status === "terminal" || ch.value?.state?.status === "completing")) {
                    this.receipts.recordTerminal(ch.value);
                    this.schedule();
                } else if (ch?.type === "conversation" && ch.value) {
                    this.conversations.recordConversation(ch.value);
                    this.schedule();
                }
            }
        });
    }
    ```
  - `src/runner/runtime-graph-source.ts:172-187`: при исчезновении узла без квитанции запрашивается `this.harness.getTask(prevId)`. До подтверждения квитанции снимок честно помечается `completeness: "limited"`. Статус `orphaned` **никогда не синтезируется**.
  - `src/runner/index.ts:167-175`: `RuntimeGraphSource` инициализируется с передачей `{ harness: durable.harness }`.
- **Тестовое доказательство:** `tests/runtime-graph-source.test.ts`:
  - `runtime-graph-source: disappearance without receipt marks completeness limited without inventing orphaned outcome` (PASS).
  - `runtime-graph-source: harness commits record authoritative terminal task receipts and conversation records` (PASS).
- **Rule:** AP-012, AP-013, AP-050.

---

### 2. [P1] Аборт in-flight сессии резолвит ожидающие запросы с убитым процессом runner
- **Было:** При `admission.aborted = true` вызывался `session.kill()` и затем `this.admission.release(admission, session)`, из-за чего параллельные клиенты получали мертвый процесс runner.
- **Статус:** **CLOSED / FIXED**
- **Evidence в коде:**
  - `src/host/session-admission.ts:98-106`:
    ```ts
    public reject(admission: InFlightAdmission, err: unknown): void {
        if (admission.released) return;
        this.cleanup(admission);
        if (admission.session && !admission.aborted) {
            try { admission.session.kill(); } catch {}
        }
        for (const p of admission.participants.values()) p.reject(err);
    }
    ```
  - `src/host/session-registry.ts:107-111, 139-143`:
    ```ts
    if (admission.aborted) {
        session.kill();
        this.admission.reject(admission, new SessionCreationAbortedError());
        throw new SessionCreationAbortedError();
    }
    ```
  - `src/host/session-registry.ts:149-154`:
    ```ts
    } catch (err) {
        if (!admission.released) {
            this.admission.reject(admission, err);
        }
        throw err;
    }
    ```
- **Тестовое доказательство:** `tests/session-admission-lifecycle.test.ts`:
  - `Finding 1 (P1): aborted admission rejects waiting Promise with typed error, does NOT resolve with killed runner` (PASS).
- **Rule:** AP-012, AP-022, AP-023, AP-034.

---

### 3. [P1] Остановка дочернего треда-официанта убивает корневой процесс, либо оставляет остановленный тред зарегистрированным
- **Было:** Официанты (`kind: "wait"`) не находились в `byThreadId`, поэтому `stop(childThreadId)` не отменял ожидание. Если дочерний тред инициировал создание сессии до родителя, `stop(childThreadId)` убивал shared root runner.
- **Статус:** **CLOSED / FIXED**
- **Evidence в коде:**
  - `src/host/session-admission.ts:40-54`: каждый участник трекается как `AdmissionParticipant` (`threadId`, `isRoot`, `promise`, `resolve`, `reject`, `aborted`) и индексируется в `this.byThreadId`.
  - `src/host/session-admission.ts:108-146`: в методе `abort(threadId)`:
    - если останавливается дочерний тред (`!isRoot`), прерывается только его ожидание (`participant.aborted = true; participant.reject(...)`), `threadId` удаляется из `byThreadId`;
    - проверяется `const hasActive = Array.from(admission.participants.values()).some((p) => !p.aborted)`;
    - если активные участники (root или другие дети) есть, сессия **НЕ убивается**;
    - если останавливается root (`threadId === admission.rootThreadId`), сессия убивается и отклоняются все участники.
  - `src/host/session-registry.ts:114-122`: при завершении создания сессии, инициированной дочерним тредом, если дочерний тред был абортирован (`childAborted`), сессия сохраняется за `parentThreadId`, а дочерний тред отклоняется типизированной ошибкой и не регистрируется в `this.sessions`.
- **Тестовое доказательство:** `tests/session-admission-lifecycle.test.ts`:
  - `Finding 2A (P1): stop child waiter cancels wait, does not attach later, does not affect root or other child waiters` (PASS).
  - `Finding 2B (P1): child initiates creation before root: stop child creator does NOT kill shared root` (PASS).
  - `Finding 2C (P1): dispose/stopAll rejects all affected requests with safe typed error and does not return killed runner` (PASS).
- **Rule:** AP-013, AP-027, AP-034.

---

### 4. [P1] Использование Node.js `Buffer.byteLength` в Zod-схеме ломает клиентскую валидацию в UI/браузере
- **Было:** В `src/runtime-graph/schema.ts` вызов `Buffer.byteLength(json, "utf8")` вызывал `ReferenceError` в браузере/Electron renderer, перехватывался `catch` и возвращал `false`, блокируя чтение любого снимка в UI.
- **Статус:** **CLOSED / FIXED**
- **Evidence в коде:**
  - `src/runtime-graph/schema.ts:115-133`: выделена платформо-независимая функция `getUtf8ByteLength`:
    ```ts
    export function getUtf8ByteLength(str: string): number {
        if (typeof Buffer !== "undefined") {
            return Buffer.byteLength(str, "utf8");
        }
        if (typeof TextEncoder !== "undefined") {
            return new TextEncoder().encode(str).length;
        }
        let bytes = 0;
        for (let i = 0; i < str.length; i++) {
            const code = str.charCodeAt(i);
            if (code <= 0x7f) bytes += 1;
            else if (code <= 0x7ff) bytes += 2;
            else if (code >= 0xd800 && code <= 0xdbff) {
                bytes += 4;
                i++;
            } else bytes += 3;
        }
        return bytes;
    }
    ```
  - Использована в `runtimeGraphSnapshotSchema.refine`: `getUtf8ByteLength(json) <= MAX_SNAPSHOT_BYTES`.
- **Тестовое доказательство:** `tests/runtime-graph-contract.test.ts`:
  - `runtime-graph-contract: validates snapshot without global Buffer (browser/UI environment)` (PASS при удаленном `globalThis.Buffer`).
- **Rule:** AP-026, AP-051, AP-066.

---

### 5. [P2] Неработающая дедупликация снимков в `RuntimeGraphSource` из-за опережающей мутации revision
- **Было:** `++this.revision` и `this.clock()` вызывались до сериализации и сравнения, из-за чего снимки никогда не признавались равными.
- **Статус:** **CLOSED / FIXED**
- **Evidence в коде:**
  - `src/runner/runtime-graph-source.ts:152-162`:
    ```ts
    const structuralJson = JSON.stringify({ nodes: mappedNodes, conversations, receipts, completeness, stats });
    if (structuralJson === this.lastStructuralJson) return;
    this.lastStructuralJson = structuralJson;

    const snapshot: RuntimeGraphSnapshot = {
        version: 1, scope: this.scope,
        observation: { epoch: this.epoch, revision: ++this.revision, observedAt: this.clock(), completeness },
        nodes: mappedNodes, conversations, receipts, stats,
    };
    for (const listener of this.listeners) listener(snapshot);
    ```
  - Структурное состояние графа сравнивается **ДО** инкремента `revision` и взятия времени. Холостые вызовы `publish()` не меняют ревизию и не уведомляют слушателей.
- **Тестовое доказательство:** `tests/runtime-graph-source.test.ts`:
  - `runtime-graph-source: deduplicates identical structural state before revision and timestamp (does not spam)` (PASS).
- **Rule:** AP-018, AP-045.

---

### 6. [P2] Дочерние субтреды Beyond Boundaries не получают scoped `runtime_graph_snapshot` дельты
- **Было:** Событие `runtime_graph_snapshot` отсылалось только в родительский тред; дочерние треды не получали изолированный граф.
- **Статус:** **CLOSED / FIXED**
- **Evidence в коде:**
  - `src/host/session-subagent-handler.ts:112-140`:
    ```ts
    if (event.type === "runtime_graph_snapshot" && !event.conversationId) {
        const rootId = String((event.snapshot as any)?.scope?.rootConversationId ?? "1");
        const convKeys = new Set<string>([
            ...Object.keys((event.snapshot as any)?.conversations ?? {}),
            ...this.mirrors.getConversationIds(),
        ]);
        for (const cid of convKeys) {
            if (cid === rootId) continue;
            const childThreadId = session.getThreadIdForConversation(cid);
            const childEvent = { ...event, conversationId: cid, parentRef: undefined };
            if (childThreadId) {
                const childTranslator = this.getChildTranslator(childThreadId);
                const childDeltas = childTranslator.translate(childEvent, {
                    threadId: childThreadId,
                    cwd: session.options.cwd,
                    providerOptions: session.options.providerOptions,
                });
                if (childDeltas.length > 0) {
                    sendNotification("thread/delta", { threadId: childThreadId, deltas: childDeltas });
                }
            } else if (this.mirrors.getState(cid)) {
                this.mirrors.bufferEvent(cid, childEvent);
            }
        }
        return false;
    }
    ```
  - Возврат `false` гарантирует передачу исходного полного снимка на родительский тред в `src/host/session.ts`.
  - В `src/host/runtime-graph-delta.ts:17-19` вызов `filterSnapshotForConversation(snapshot, targetConversationId)` изолирует граф под конкретную беседу.
- **Тестовое доказательство:** `tests/runtime-graph-bridge.test.ts`:
  - `runtime-graph-bridge: SessionSubagentHandler delivers scoped graph snapshot to child threads` (PASS).
- **Rule:** AP-026, AP-048.

---

### 7. [P2] Пересборка `conversations` только из live-узлов приводит к потере иерархии после завершения задач
- **Было:** Словарь `conversations` собирался только из текущих живых задач; после завершения задачи связь владения `{ conversationId, taskId }` терялась.
- **Статус:** **CLOSED / FIXED**
- **Evidence в коде:**
  - `src/runner/runtime-graph-conversations.ts:1-43`: создан класс `RuntimeGraphConversations`.
  - Связи бесед накапливаются персистентно:
    - метод `recordFromLiveNode` фиксирует ссылки `node.conversations` из активных задач;
    - метод `recordConversation` сохраняет данные из коммитов `ConversationRecord`.
  - При завершении и выбытии задачи-владельца запись беседы и её `owner` сохраняются в памяти источника графа.
- **Тестовое доказательство:** `tests/runtime-graph-source.test.ts`:
  - `runtime-graph-source: owner chain is preserved after owner task completes` (PASS).
  - `runtime-graph-ownership: terminal owner retains conversation ownership` (PASS).
- **Rule:** AP-013, AP-038.

---

### 8. [P2] `createOrGet` возвращает существующую сессию без проверки соответствия `providerThreadId` и `sessionKey`
- **Было:** Метод `createOrGet` возвращал существующую сессию по `threadId` или `parentThreadId` без проверки совпадения `sessionKey`.
- **Статус:** **CLOSED / FIXED**
- **Evidence в коде:**
  - `src/host/session-registry.ts:65-72`:
    ```ts
    const existing = this.sessions.get(threadId);
    if (existing && !existing.runner?.exited) {
        const existingKey = parseProviderThreadId(existing.options.providerThreadId).sessionKey;
        if (existingKey !== sessionKey) {
            throw new SessionIdentityMismatchError(`SESSION_IDENTITY_MISMATCH: thread ${threadId} is bound to ${existingKey}, requested ${sessionKey}`);
        }
        return existing;
    }
    ```
  - `src/host/session-registry.ts:80-86`: аналогичная проверка для кандидата родительской сессии `parentThreadId`.
  - Ошибка выбрасывается до любых мутаций внутреннего состояния `this.sessions`.
- **Тестовое доказательство:** `tests/session-admission-lifecycle.test.ts`:
  - `Finding 3A (P2): same threadId returns existing only when sessionKey matches; mismatch throws typed error without mutating binding` (PASS).
  - `Finding 3B (P2): child requesting parentThreadId with mismatched sessionKey throws typed error and does not mutate parent` (PASS).
- **Rule:** AP-039, AP-048.

---

## 3. Дополнительные глубокие проверки архитектурных инвариантов

### 3.1. Реальная доставка нативных квитанций в entrypoint runner
- **Проверено:** В файле `src/runner/index.ts:167-175`:
  ```ts
  activeGraphSource = new RuntimeGraphSource(
      durable.view,
      {
          sessionId: durable.view.current().session.id,
          rootConversationId: String(ROOT_CONVERSATION_ID),
          buildId: "pi-durable-1.4",
      },
      {
          harness: durable.harness,
      },
  );
  activeGraphSource.subscribe((snapshot) => output({ type: "runtime_graph_snapshot", snapshot }));
  ```
  Инстанс `durable.harness` передается в конструктор `RuntimeGraphSource`. Подписка на коммиты задач активна с момента инициализации сессии. На завершении процесса (`handleExit`) вызывается `activeGraphSource.teardown()`.
- **Missing outcome неизвестен:** Если задача завершилась и исчезла из `view.tasks` до получения квитанции, `RuntimeGraphSource.reconcileDisappearedNodes` запрашивает `harness.getTask(prevId)` и устанавливает `completeness: "limited"`. Никаких фиктивных `orphaned` статусов не синтезируется.

### 3.2. Дедупликация и независимость от часов
- **Проверено:** Поле `this.lastStructuralJson` вычисляется исключительно из структурных данных (`nodes`, `conversations`, `receipts`, `completeness`, `stats`). Часы `clock()`, ревизия `revision` и эпоха `epoch` в сравнение не входят. Если структура графа неизменна, публикация прерывается (`return`), ревизия не инкрементируется, спам дельтами исключен.

### 3.3. Скоупинг графа и сохранение владения терминальными задачами
- **Проверено:** Функция `filterSnapshotForConversation` в `src/runner/runtime-graph-scope.ts` рекурсивно проверяет цепочку владения через `isConversationInScope`. Так как `RuntimeGraphConversations` сохраняет связь `owner: { conversationId, taskId }` даже после перехода задачи `taskId` в квитанции, дочерняя беседа стабильно сохраняет свой скоуп видимости. Взаимное протекание задач между соседними (sibling) дочерними тредами исключено (подтверждено тестом `runtime-graph-ownership.test.ts:34`).

### 3.4. Ограничение объема данных (Retention, Packet Cap, Trimming)
- **Проверено:**
  - `MAX_LIVE_NODES = 512`: при превышении отображаются первые 512 узлов (`.slice(0, MAX_LIVE_NODES)`), а снимок помечается `completeness: "limited"`.
  - `MAX_RECEIPTS = 128`: кольцевой буфер `RuntimeGraphReceiptsCollector` вытесняет старейшие квитанции при переполнении.
  - `MAX_LABEL_LENGTH = 160`, `MAX_PREVIEW_LENGTH = 500`.
  - `MAX_SNAPSHOT_BYTES = 1048576` (1 MiB): жесткий лимит полезной нагрузки, верифицируемый схемой `runtimeGraphSnapshotSchema`.
  - Клиентское чтение (`src/ui/runtime-graph/read.ts`): ограничено лимитом `MAX_EVENT_PAGES = 5` страниц по 100 событий (`PAGE_SIZE = "100"`), предотвращая зависание UI при чтении длинных историй тредов.

### 3.5. Жизненный цикл клиента, эпохи и очистка ресурсов
- **Проверено:**
  - `RuntimeGraphSource` генерирует уникальную эпоху `epoch_${this.clock()}_...` при каждом создании сессии.
  - Подписчик UI `subscribeRuntimeGraph` (`src/ui/runtime-graph/subscription.ts`) отслеживает `lastEpoch` и `lastRevision`. События из устаревших эпох или с меньшей ревизией отбрасываются.
  - Функция отписки корректно прерывает таймер, отменяет сетевой запрос через `AbortController.abort()` и снимает слушатель `thread:changed`.

### 3.6. Concurrency Admission: Single Writer и безопасный Teardown
- **Проверено:**
  - Параллельные вызовы `thread/start` и `turn/start` на одном `sessionKey` коалесцируются в единую сессию без коллизий файловой блокировки SQLite (подтверждено тестом `session-admission-race.test.ts`).
  - Все отмененные участники детерминированно получают типизированную ошибку `SessionCreationAbortedError`. Никаких утечек убитого runner-процесса.
  - Остановка дочернего треда изолирована и не нарушает работу корневой сессии.
  - Вызов `stopAll()` или `dispose()` очищает все очереди допуска и безопасно завершает сессии.

---

## 4. Разграничение кода и внешних барьеров (Integration & UI Gates)

Необходимо строго различать статус исходного кода библиотеки/плагина и внешние платформенные ограничения:

1. **Кодовый уровень (Code Invariants & Logic):**
   - **P0 / P1 / P2 дефекты: 0 (ОТСУТСТВУЮТ).**
   - Все контракты Zod, DTO, адаптеры, обработчики ошибок, дедупликация и координатор допуска реализованы корректно и проверены тестами.
   - Бюджет строк AP-019 строго соблюден: все 18 ключевых `.ts` файлов < 200 строк.
   - Граф импортов AP-025 строго ацикличен (0 циклов).
   - TypeScript компиляция `npx tsc --noEmit` и негативные контракты типов (`test:contracts`) проходят без ошибок.

2. **Непроверенный Live Seam (External Integration Capability Gate):**
   - **Персистенция `extension.state` в локальной SQLite БД Beyond Boundaries:** Внутренняя цепочка событий (генерация в раннере → передача по каналу → `DeltaTranslator` → `sendNotification("thread/delta", ...)`) доказана unit- и мок-тестами. Однако фактическое поведение десктопного демона Beyond Boundaries (будет ли он сохранять дельты `extension.state` в таблицу событий, возвращать их через `sdk.threads.events.list`, и триггерить инвалидацию `thread:changed` при закрытых/фоновых окнах) является внешней характеристикой закрытого ядра BB. Этот барьер не является кодовым багом данного репозитория, но фиксируется как **интеграционный capability gate**, требующий e2e валидации на живом приложении.

3. **UI-Policy Gate: Ограничение контекстного сегмента G3:**
   - В соответствии с инвариантом тонкого адаптера в `AGENTS.md` ("Не изобретать свои UI-компоненты или кастомные FSM-движки") разработка UI-компонентов визуализации графа задач (G3) остаётся **ЗАБЛОКИРОВАННОЙ** до явного подтверждения оператора (Вани) на внесение согласованного исключения в `AGENTS.md`.

---

## 5. Архитектурная верификация (Architecture Verification)

- **Passed:**
  - `AP-010` (Модульный монолит + Ports & Adapters): Транспорт, сборщик квитанций и координатор допуска строго разделены по портам.
  - `AP-011` (Низкая связность и высокая когезия): Четкие ответственности модулей (`RuntimeGraphSource`, `RuntimeGraphConversations`, `RuntimeGraphReceiptsCollector`, `SessionAdmissionCoordinator`).
  - `AP-012` (Fail-fast и явные контракты ошибок): Отказ от фиктивных `orphaned` статусов; строгая типизация ошибок допуска.
  - `AP-013` (Целостность пользовательских данных): Отсутствие фальсификации завершенных задач; сохранение дерева владения бесед; предотвращение случайного убийства корневой сессии при остановке дочернего треда.
  - `AP-016` (Доверенная security-граница): Секреты и пути не утекают в DTO графа.
  - `AP-018` (Ясность и одна ответственность): Дедупликация отделена от мутации ревизии и часов.
  - `AP-019` (Лимиты размера и смысловое дробление): Все 18 затронутых файлов строго < 200 строк (максимальный — `src/runner/index.ts`: 197 строк).
  - `AP-020` (Clean Architecture и composition root): Композиция выполнена в `server.ts` и `src/runner/index.ts`.
  - `AP-021` (Тонкие entry points): Хэндлеры команд делегируют в специализированные модули.
  - `AP-022` (Typed errors и явная обработка исключений): Использованы `SessionCreationAbortedError` и `SessionIdentityMismatchError`.
  - `AP-023` (Async дисциплина и no floating promises): Все промисы допуска детерминированно разрешаются или отклоняются; отсутствие висячих ожиданий.
  - `AP-025` (Дисциплина импортов): 0 циклических зависимостей по всему проекту.
  - `AP-026` (API-контракты и DTO границы): Схема DTO полностью кроссплатформенна (`getUtf8ByteLength` без зависимости от Node `Buffer`).
  - `AP-027` (Конфигурация и teardown): Полноценный lifecycle cleanup в `activeGraphSource.teardown()` и `SessionAdmissionCoordinator.dispose()`.
  - `AP-028` (Стратегия тестирования и детерминизм): Все 43 теста графа и 12 тестов допуска детерминированы.
  - `AP-029` (TypeScript strictness): 0 ошибок `tsc --noEmit`, контрактные негативные проверки пройдены.
  - `AP-034` (Явная стратегия конкурентного доступа): Single Writer для SQLite-сессии гарантирован координатором допуска.
  - `AP-038` (Сквозной контекст запроса и traceability): Связь бесед с создавшими задачами сохраняется персистентно.
  - `AP-039` (Auth boundary и доверенная идентичность): Валидация `sessionKey` предотвращает смешение сессий.
  - `AP-045` (Защита от злоупотреблений и resource exhaustion): Честная дедупликация снимков предотвращает спам событиями; жесткие лимиты на 512 узлов и 1 MiB полезной нагрузки.
  - `AP-048` (Явное соответствие идентификаторов): `threadId` и `sessionKey` строго согласованы; веерная доставка дельт использует точный `childThreadId`.
  - `AP-050` (Справочные данные, статусы и перечисления как контракты): Статусы задач берутся авторитетно из рантайма Pi Durable.
  - `AP-051` (Frontend feature boundaries): Браузерная совместимость Zod-схемы в UI гарантирована.

- **Residual risk:**
  - **Live Host Persistence:** Сквозное сохранение и выборка `extension.state` в реальном процессе Beyond Boundaries требует проверки при установке плагина в настольное приложение.
  - **G3 UI Activation:** Слой визуализации контекстного сегмента ожидает внесения согласованного исключения в `AGENTS.md`.

---

## 6. Итоговый вердикт

**VERDICT: PASS**

Все 8 исторических дефектов (P1/P2) полностью устранены в исходных кодах и верифицированы регрессионными тестами. Архитектурный baseline `arch-rules.md` соблюден. Блокирующие кодовые замечания сняты.
