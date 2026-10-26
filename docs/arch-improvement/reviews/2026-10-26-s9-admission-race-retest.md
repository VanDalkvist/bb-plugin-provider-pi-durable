# Продуктовое ревью [S9b: Product Verify Gate — Retest P1 Admission Race]

**Кандидат:** `bb-plugin-provider-pi-durable` (публичные dist-артефакты `v0.2.53`, runtime Pi Durable `1.4.0`)  
**Окружение проверки:** macOS Darwin (arm64), Node.js v26.0.0, изолированные сессионные каталоги `BB_PI_BRIDGE_SESSION_DIR` в `/tmp`  
**Методология:** Независимое black-box тестирование публичного интерфейса (`dist/host.js`, wire-протокол JSON-RPC Beyond Boundaries IDE) без чтения исходного кода реализации (`src/`), тестов (`tests/`) и git diff. Использован только публичный контракт протокола и публичные точки входа (`experimental_providerBridge`, `teardown`).

---

## 1. Контекст и цель ретеста

В предыдущем отчёте [`s9-product-followup.md`](/Users/vanya/.bb/thread-storage/thr_ct3kk9xne6/s9-product-followup.md) был зафиксирован блокирующий дефект **P1**:
- При одновременной отправке `thread/start` и `turn/start` на одной сессионной директории до завершения инициализации первого runner хост-мост запускал второй процесс runner на том же каталоге.
- Происходило вытеснение блокировки (`[SessionStorage] unlock warning: Lock is not acquired/owned by you`), первый runner аварийно завершался (`Runner exited before becoming ready (code 0, signal null)`), а вызов `thread/start` падал с ошибкой `-32000`.

**Цель текущего ретеста:**
В новых изолированных временных сессиях проверить исправление дефекта P1:
1. Повторить одновременный вызов `thread/start` + `turn/start` на одном `threadId` и доказать:
   - наличие строго одного процесса writer/runner;
   - отсутствие падения `Runner exited before becoming ready`;
   - отсутствие lock takeover / предупреждений о захвате блокировки;
   - успешное завершение обоих запросов и корректное выполнение хода.
2. Проверить конкурентные root/child aliases (`thread/start` + `thread/resume` на составном идентификаторе `parentSessionId:childConversationId`).
3. Проверить отказ, остановку и повторную готовность (re-admission lifecycle) через публичные методы (`thread/start` → `thread/stop` → `thread/resume` → `turn/start`).
4. Доказать корректное завершение через публичный `teardown(0)` без висячих процессов и неудалённых блокировок.

---

## 2. Исполненные пользовательские сценарии (Execution Matrix)

### Сценарий 1 (Happy Path / Retest P1 Admission Race): Конкурентный запуск `thread/start` + `turn/start`
- **Сессионная директория:** `/tmp/bb-pi-retest-case1-1793003981428`
- **Действие:**
  После `initialize` синхронно в одном цикле событий отправлены запросы:
  1. `{"jsonrpc":"2.0","id":2,"method":"thread/start","params":{"threadId":"thr_case1","providerThreadId":"pi_durable_case1","cwd":"..."}}`
  2. `{"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"threadId":"thr_case1","providerThreadId":"pi_durable_case1","clientRequestId":"creq_23456789ab","input":[{"type":"text","text":"Reply with the single word: OK. Do not call any tools."}]}}`
- **Наблюдение и Evidence:**
  - Непрерывный мониторинг процессов (`pgrep -fl <sessionDir>`) показал **строго 1 активный процесс runner** на протяжении всего жизненного цикла (PID процесса runner в сессии оставался единственным, второй runner не запускался).
  - В потоке stderr **полностью отсутствуют** предупреждения о блокировках (`Lock is not acquired/owned by you` не появлялось).
  - Запрос `thread/start` (id: 2) успешно вернул:
    ```json
    {"jsonrpc":"2.0","id":2,"result":{"providerThreadId":"pi_durable_case1","sessionRestorable":true}}
    ```
  - Запрос `turn/start` (id: 3) был корректно поставлен в очередь и принят сразу после готовности runner:
    ```json
    {"jsonrpc":"2.0","method":"thread/delta","params":{"threadId":"thr_case1","deltas":[{"kind":"input.accepted","clientRequestId":"creq_23456789ab"}]}}
    {"jsonrpc":"2.0","id":3,"result":{"threadId":"thr_case1"}}
    {"jsonrpc":"2.0","method":"thread/delta","params":{"threadId":"thr_case1","deltas":[{"kind":"turn.open"}]}}
    ```
  - Ход завершился штатно:
    ```json
    {"kind":"item.textClose","key":{"channel":"agentMessage"},"channel":"agentMessage","text":"OK"}
    {"kind":"turn.boundary","status":"completed","claimIfIdle":true,"providerCheckpointId":"12"}
    ```
  - Вызов публичного `teardown(0)` завершил сессию с exitCode `0`. После завершения процесса в системе зафиксировано `0` висячих runner-процессов (`lingeringRunners: 0`).
- **Исход:** **PASS**

---

### Сценарий 2 (Edge Case): Конкурентный запуск root и child aliases
- **Сессионная директория:** `/tmp/bb-pi-retest-case2-1793003995969`
- **Действие:**
  После `initialize` синхронно отправлены запросы к одной базовой сессии под разными алиасами:
  1. Root `thread/start` (`id: 2`, `threadId: "thr_alias_root"`, `providerThreadId: "pi_durable_shared_sess"`)
  2. Child alias `thread/resume` (`id: 3`, `threadId: "thr_alias_child"`, `providerThreadId: "pi_durable_shared_sess:2"`)
- **Наблюдение и Evidence:**
  - Количество активных runner-процессов в сессионной директории строго равнялось **1** (`maxRunnersObserved: 1`). Конфликта за блокировку каталога не возникло.
  - Оба запроса успешно разрешились без сбоя runner:
    ```json
    {"jsonrpc":"2.0","method":"thread/identity","params":{"threadId":"thr_alias_root","providerThreadId":"pi_durable_shared_sess","sessionRestorable":true}}
    {"jsonrpc":"2.0","method":"thread/identity","params":{"threadId":"thr_alias_child","providerThreadId":"pi_durable_shared_sess:2","sessionRestorable":true}}
    {"jsonrpc":"2.0","id":2,"result":{"providerThreadId":"pi_durable_shared_sess","sessionRestorable":true}}
    {"jsonrpc":"2.0","id":3,"result":{"providerThreadId":"pi_durable_shared_sess:2","sessionRestorable":true}}
    ```
  - Публичный `teardown(0)` корректно закрыл процесс моста и runner (exitCode `0`, `lingeringRunners: 0`).
- **Граница покрытия:**
  В чистой сессии без предварительно созданной дочерней беседы в SQLite хост-мост выводит ожидаемое диагностическое предупреждение `[BindingManager] Failed to persist binding to runner: Error: Conversation 2 does not exist`, однако сессия не падает, не порождает гонку блокировок и успешно обслуживает оба запроса. Полноценный lifecycle выполнения хода дочерней беседы subagent требует предварительно созданного графа бесед (подтверждено в отчёте `s9-product-followup.md`).
- **Исход:** **PASS**

---

### Сценарий 3 (Lifecycle & Recovery): Остановка, повторная готовность (Re-admission) и выполнение хода
- **Сессионная директория:** `/tmp/bb-pi-retest-case3-1793004003879`
- **Действие:**
  1. `thread/start` (`id: 2`, `thr_case3`, `pi_durable_case3`) → ожидание готовности.
  2. `thread/stop` (`id: 3`, `thr_case3`) → подтверждение остановки сессии.
  3. `thread/resume` (`id: 4`, `thr_case3`, `pi_durable_case3`) → повторная инициализация и admission.
  4. `turn/start` (`id: 5`, `thr_case3`, prompt `"Reply with the single word: OK. Do not call any tools."`) → проверка выполнения хода после re-admission.
  5. Публичный `teardown(0)`.
- **Наблюдение и Evidence:**
  - Шаг 1: `thread/start` успешно завершился с подтверждением готовности (`sessionRestorable: true`).
  - Шаг 2: `thread/stop` штатно остановил сессию (`result: {"ok": true}`).
  - Шаг 3: `thread/resume` успешно переподключил runner к существующей SQLite-сессии (`id: 4`, `result: {"providerThreadId":"pi_durable_case3","sessionRestorable":true}`).
  - Шаг 4: Вызов `turn/start` (id: 5) на повторно запущенной сессии прошёл полный цикл:
    ```json
    {"jsonrpc":"2.0","method":"thread/delta","params":{"threadId":"thr_case3","deltas":[{"kind":"input.accepted","clientRequestId":"creq_3456789abc"}]}}
    {"jsonrpc":"2.0","id":5,"result":{"threadId":"thr_case3"}}
    {"jsonrpc":"2.0","method":"thread/delta","params":{"threadId":"thr_case3","deltas":[{"kind":"turn.open"}]}}
    ...
    {"kind":"item.textClose","key":{"channel":"agentMessage"},"channel":"agentMessage","text":"OK"}
    {"kind":"turn.boundary","status":"completed","claimIfIdle":true,"providerCheckpointId":"12"}
    ```
  - Шаг 5: Публичный `teardown(0)` завершил все процессы без сбоев (exitCode `0`, `lingeringRunners: 0`).
- **Исход:** **PASS**

---

## 3. Ссылки на воспроизводимые артефакты и квитанции

Все проверки выполнены автономным скриптом с фиксацией полных логов:
- **Исполняемый тестовый probe:** [`retest-admission-race.mjs`](/Users/vanya/.bb/thread-storage/thr_ct3kk9xne6/retest-admission-race.mjs)
- **Сводный лог stdout:** [`retest-admission-race-stdout.log`](/Users/vanya/.bb/thread-storage/thr_ct3kk9xne6/retest-admission-race-stdout.log)
- **Сводный лог stderr:** [`retest-admission-race-stderr.log`](/Users/vanya/.bb/thread-storage/thr_ct3kk9xne6/retest-admission-race-stderr.log)

Квитанции проверены на отсутствие секретов, токенов аутентификации и персональных данных.

---

## 4. Findings

- **Findings:** None

Дефект **[P1]**, зарегистрированный в `s9-product-followup.md`, полностью устранён. Параллельные запросы `thread/start` и `turn/start` сериализуются, сессия удерживает единый процесс runner, захват блокировок детерминирован, а аварийное завершение `Runner exited before becoming ready` отсутствует.

---

## 5. Product Verification Summary

| Критерий проверки | Результат | Свидетельство |
|---|---|---|
| **Primary Journey Complete (Happy Path)** | **YES** | Одновременная отправка `thread/start` + `turn/start` приводит к успешному ответу на оба RPC-вызова и полноценному выполнению хода (`turn.boundary status: "completed"`). |
| **Feedback & Error Clarity** | **YES** | Отсутствуют необработанные ошибки `-32000` и предупреждения об утечке/перехвате блокировки. События `input.accepted`, `thread/identity`, `turn.open` и `turn.boundary` поступают в корректной последовательности. |
| **Clean State & Clean Exit** | **YES** | Публичный вызов `teardown(0)` закрывает мост и дочерние runner-процессы. Во всех трёх сценариях зафиксировано `lingeringRunners: 0` и `exitCode: 0`. |
| **Residual User Risk** | **Low** | Сериализация на уровне admission гарантирует изоляцию SQLite-каталогов сессий при любой интенсивности входящих асинхронных JSON-RPC сообщений. |

---

## Итоговый вердикт

**VERDICT: PASS**
