# Архитектурное ревью: единый итоговый раунд проверки настройки субагентов

- **Дата:** 2026-10-25
- **Объект ревью:** `bb-plugin-provider-pi-durable`
- **Проверяемый кандидат:** коммит `53c6c6b` (база задачи `4d02d4c`)
- **Контур проверки:** архитектурный (Boundaries, DTOs, Runtime Lifecycles, Concurrency, Packaging, Host/Runner Invariants)
- **Базовые правила:** `arch-rules` (AP-010 – AP-071), `bb-plugin-provider-pi-durable/AGENTS.md`, `~/Projects/AGENTS.md`
- **Тестовый статус кандидата:** 395 passed (390 Node unit/integration + 5 UI DOM), tsc exit 0, build exit 0, runner bundle 143,947 bytes. SDK check exit 1 (документированное runtime-отклонение: SDK остаётся в production dependencies для изолированного моста провайдера).

---

## 1. Архитектурная оценка согласованного функционала

### 1. Границы владения и тонкость адаптера (The Thin Adapter Invariant, AP-010, AP-011, AP-020)
- **Beyond Boundaries (BB):** владеет UI настроек (`app.slots.settingsSection`) в `app.tsx` и `src/ui/settings-subagent-section.tsx`, сохранением глобальной политики через namespaced KV (`subagent.policy.v1`) и маршрутизацией запросов каталогов моделей через существующий SDK API `sdk.providers.models`. Кастомный host RPC для чтения каталога отсутствует.
- **Pi AI / Pi Coding Agent:** владеет каталогом моделей (`ModelCatalog`, `api.models`), аутентификацией/ключами и вычислением поддерживаемых уровней рассуждений (`getSupportedThinkingLevels`).
- **Pi Durable:** владеет жизненным циклом и выполнением дочерних задач (`SubagentRecord`, транзакции `api.commit`, `tx.createConversation`, `configure`). Модель и reasoning фиксируются на уровне дочерней беседы и замораживаются для каждого ребёнка в момент создания.
- **Оценка:** Границы разделены чисто; плагин не изобретает собственный scheduler или сторонний каталог моделей. Изменения локализованы в слоях `policy/`, `runner/`, `host/`, `ui/`.

### 2. DTO, валидация и обработка ошибок (AP-012, AP-013, AP-022, AP-026)
- Хранилище `SubagentPolicyStore` (`src/policy/store.ts`) и RPC-контракт (`src/rpc/contract.ts`) строго типизированы через Zod (`.strict()`).
- Версия схемы зафиксирована (`version: 1`), ревизия строго целочисленная неотрицательная (`revision: z.number().int().nonnegative()`), режим дискриминирован (`"inherit" | "configured"`).
- Метод `hydrate()` выполняется асинхронно до регистрации провайдера `bb.providers.register` в `server.ts`. При ошибке чтения или повреждении данных выбрасывается типизированная ошибка `SubagentPolicyLoadError` с сохранением `cause` (AP-022). Тихий fallback в `inherit` исключён (AP-012, AP-013).
- В `src/policy/errors.ts` реализована иерархия типизированных ошибок: `SubagentPolicyInvalidError`, `SubagentModelUnavailableError`, `SubagentPolicyLoadError`, `SubagentRevisionConflictError`.

### 3. Конкурентность, CAS и персистентность (AP-033, AP-034, AP-035)
- В `SubagentPolicyStore` и `SubagentPolicyHolder` запись сериализуется через FIFO-очередь промисов (`writeQueue`).
- Реализован строгий optimistic concurrency control (CAS) по полю `expectedRevision`. Конфликт ревизий возвращает `SubagentRevisionConflictError` (маппится в `experimental_PluginRpcRefusal({ code: "conflict" })`).
- Персистентность организована по принципу **persist-before-cache**: внутренняя переменная `currentRecord` обновляется только после успешного выполнения `await this.kv.set(...)` или транзакции `harness.commit(...)`.
- Идемпотентность: повторная запись той же ревизии с идентичным payload в runner признаётся успешным no-op (AP-035), попытка downgrade ревизии отклоняется.

### 4. Доставка политики и изоляция жизненного цикла детей (AP-016, AP-047, AP-048)
- Доставка новой политики сессиям происходит на ходу владельца (owner turn) через `reconcileSessionOptions` -> `set_subagent_policy`. Runner подтверждает сохранение в сессионном документе `SubagentPolicyAckDoc` (`scope: "session"`).
- При перезапуске сессии ACK восстанавливается до вызова `harness.resume()`. Повреждённый документ вызывает fail-fast с корректным освобождением ресурсов (`Promise.allSettled([harness?.close(), mounted.cleanup()])`).
- Каждый нативный ребёнок фиксирует свой снимок политики (`policySnapshot`) в `SubagentsDoc`. Существующие дети и безопасные повторные запуски (`replay: "safe"`) переиспользуют `existingRecord` и не переконфигурируются.
- Фоновое завершение инструмента (`details.background === true` в `tool_execution_end`) трактуется только как подтверждение запуска; терминальный статус ребёнка формируется исключительно по событию `agent_end`.

### 5. Упаковка и бюджет строк файлов (AP-019, AP-025)
- Все новые и модифицированные production-файлы (`.ts` и `.tsx`) строго удовлетворяют лимиту AP-019 (< 200 строк, soft limit 150, hard limit 250).
- Бандлер раннера (`scripts/build-runner.mjs`) внешне связывает (`external: ["zod"]`) библиотеку Zod, которая является production-зависимостью. Размер бандла `dist/runner/index.js` составляет 143,947 байт (вместо 897,640 байт до оптимизации).
- Регрессионный тест упаковки `tests/runner-packaging.test.ts` проверяет сборку с внешним Zod и работоспособность валидации схем при импорте.

---

## 2. Обнаруженные дефекты (Findings)

### [P1] Fail-open валидации модели и reasoning субагента при холодном зеркале из-за DTO mismatch в get_state
- **Evidence:** `src/host/child-turn-guard.ts:98-113` vs `src/runner/session-state-commands.ts:37-43`.
  Исполняемое доказательство (Node reproduction):
  ```bash
  node --experimental-strip-types -e '
  import { validateChildTurn } from "./src/host/child-turn-guard.ts";
  async function test() {
    const session = {
      options: { threadId: "root_1" },
      getSubagentState: () => ({ status: "running", task: "task" }), // cold mirror, no actualModel
      runner: {
        requestOk: async () => ({
          model: { provider: "antigravity", id: "gemini-3.8-flash", modelId: "gemini-3.8-flash" },
          thinkingLevel: "high"
        })
      }
    };
    const res = await validateChildTurn({
      threadId: "child_1",
      options: { model: "anthropic/claude-3-7-sonnet" }
    }, session, "conv_42");
    console.log("Result:", res);
  }
  test();
  '
  # Output: Result: { valid: true }  <-- FAIL-OPEN! Model override allowed instead of -32602 rejection!
  ```
- **Impact:** Если сессия восстанавливается после рестарта хоста (cold reconnect) и зеркало в памяти хоста ещё не содержит закешированных метаданных (`mirror.actualModel` не заполнен), `validateChildTurn` запрашивает состояние агента у runner через `get_state`. Однако `child-turn-guard.ts` ожидает структуру `(res as any)?.state?.agent ?? (res as any)?.agent`, тогда как `session-state-commands.ts` возвращает плоские поля `res.model` и `res.thinkingLevel`. В результате `agentDoc` оказывается `undefined`, переменные `actualModel` и `thinkingLevel` остаются пустыми, и блок проверок не срабатывает — несанкционированное переопределение модели дочернего треда (например, на `claude-3-7-sonnet`) ошибочно пропускается с `{ valid: true }` вместо блокировки с кодом `-32602 CHILD_MODEL_POLICY_LOCKED`.
- **Rule:** AP-012 (Fail-fast и явные контракты ошибок), AP-016 (Доверенная security-граница), AP-026 (API-контракты и DTO границы).
- **Fix decision:** fix-now (исправить извлечение в `child-turn-guard.ts`: читать `(res as any)?.model` и `(res as any)?.thinkingLevel`, либо нормализовать контракт ответа `get_state`).

### [P1] Ручные дочерние треды BB ошибочно классифицируются как зеркала субагентов, теряя доставку политики и компакшн
- **Evidence:** `src/host/child-turn-guard.ts:56-59` в сочетании с `src/host/bridge-router.ts:43-111` и `src/host/session-registry.ts:68-110`.
  Исполняемое доказательство (Node reproduction):
  ```bash
  node --experimental-strip-types -e '
  import { isChildTurn } from "./src/host/child-turn-guard.ts";
  const manualSession = {
    options: {
      threadId: "manual_subthread_1",
      providerThreadId: "pi_durable_independent_key_123"
    }
  };
  const params = {
    threadId: "manual_subthread_1",
    providerThreadId: "pi_durable_independent_key_123",
    parentThreadId: "parent_root_1"
  };
  console.log("isChildTurn:", isChildTurn(params, manualSession));
  '
  # Output: isChildTurn: true  <-- Ошибочная классификация независимой корневой сессии!
  ```
- **Impact:** Функция `isChildTurn` возвращает `true` исключительно на основании наличия `params.parentThreadId`. В `SessionRegistry` ручные субтреды BB (`bb thread spawn` или создание подтреда в UI), не являющиеся нативными дочерними беседами, получают собственную независимую сессию (`session.options.threadId === params.threadId`). Однако в `handleTurnStart` (`bridge-router.ts`) ветка `if (isChild)` перехватывает ход такого треда и:
  1. Полностью пропускает вызов `reconcileSessionOptions(session, params.options, params.providerOptions)`. В результате обновлённая глобальная политика `subagentPolicy` и выбранная модель треда никогда не доставляются в runner через команду `set_subagent_policy`.
  2. Ошибочно блокирует команду контекстной компакшн (`/compact`) с ошибкой `-32602 "Context compaction is not supported on child subagent thread"`, хотя физически это полноправная корневая сессия с собственным контекстом.
- **Rule:** AP-011 (Низкая связность и высокая когезия), AP-020 (Clean Architecture границы), AP-048 (Явное соответствие идентификаторов).
- **Fix decision:** fix-now (уточнить контракт `isChildTurn`: если `session.options.threadId === params.threadId` и нет нативного композитного conversationId или привязки в `DurableBindingStore`, сессия является полноправным владельцем и должна выполнять `reconcileSessionOptions`).

### [P2] Вымышленный идентификатор хоста "default" и избыточные опциональные проверки в `useCatalogPreview`
- **Evidence:** `src/ui/use-catalog-preview.ts:32-47` и `node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk-app.d.ts:17400-17445`.
- **Impact:** В BB SDK 0.6.79 методы `sdk.system.config()`, `sdk.hosts.list()` и `sdk.environments.list()` являются гарантированными свойствами API. Проверка вида `sdk.system?.config ? ...` избыточна. При отсутствии зарегистрированных удалённых хостов (`hosts: []`) или локальном запуске `cfg?.primaryHostId` может быть `null`. В этом случае код подставляет искусственную строку `"default"` и отправляет её в `sdk.providers.models({ providerId: "pi-durable", hostId: "default" })`. По контракту SDK `ProviderModelsArgs` для опроса локального/основного хоста поле `hostId` должно быть опущено (`hostId?: never`), тогда как обращение к несуществующему хосту `"default"` приводит к сбою запроса каталога на однохостовых инсталляциях. В блоке `catch` сбой маскируется той же строкой `"default"` (AP-013).
- **Rule:** AP-013 (Целостность пользовательских данных без фолбэков), AP-026 (API-контракты и DTO границы).
- **Fix decision:** fix-now (при отсутствии хостов не изобретать `"default"`, а либо не передавать `hostId`, либо оставлять `routing: null` с явным отображением статуса).

### [P2] Неподключенный `AbortController` и неиспользуемая ветка `AbortError` в `useCatalogPreview`
- **Evidence:** `src/ui/use-catalog-preview.ts:63, 78`.
- **Impact:** Внутри `loadModels` создаётся экземпляр `const controller = new AbortController();`, передаётся сигнал в `sdk.providers.models` и проверяется `(err as Error)?.name === "AbortError"`. Однако `controller.abort()` нигде не вызывается: ни при смене маршрута предпросмотра, ни в cleanup-функции `useEffect`. Отмена устаревших запросов является фиктивной, что ведёт к утечке фоновых запросов к хост-демону при быстром переключении контекстов.
- **Rule:** AP-023 (Async дисциплина), AP-027 (Управление ресурсами).
- **Fix decision:** fix-now (сохранять активный контроллер в `useRef` или возвращать функцию отмены из эффекта и вызывать `abort()`).

### [P2] Потеря пользовательского выбора режима при медленном сохранении политики
- **Evidence:** `src/ui/settings-subagent-section.tsx:94-124`, `src/ui/use-subagent-policy.ts:60-61`.
- **Impact:** Радио-кнопки переключения режима (`inherit` / `configured`) не имеют свойства `disabled={isSaving}`. Если сохранение занимает время, пользователь может кликнуть альтернативный режим; однако завершение `save()` безусловно перезаписывает локальный черновик (`setDraftPolicy(res.record.policy)`), молча затирая последний клик пользователя.
- **Rule:** AP-022 (UI state determinism and race prevention).
- **Fix decision:** fix-now (дизаблить радио-кнопки флагом `isSaving` во время сохранения).

### [P3] Объединение разнородных ошибок в одном блоке отображения настроек
- **Evidence:** `src/ui/settings-subagent-section.tsx:162-167`.
- **Impact:** Ошибки RPC `error`, `catalogError` и `modelLoadError` выводятся в едином блоке через цепочку тернарных операторов. Разделение ошибок хранилища и каталога улучшит диагностику в сложных окружениях.
- **Fix decision:** log-only.

### [P3] Формулировка правила по Gemini в воркспейсном `AGENTS.md`
- **Evidence:** `/Users/vanya/Projects/AGENTS.md:102-104`.
- **Impact:** Абзац «Субтреды и субагенты — строго Gemini 3.8 High (CLI fallback) либо сохранённая политика рантайма» корректно разграничивает зоны, однако предложение о запрете других моделей требует внимательности внешних субагентов, чтобы не трактовать его как запрет выбора моделей в настройках плагина.
- **Fix decision:** log-only.

---

## 3. Архитектурная верификация (Architecture Verification Matrix)

- **Passed:**
  - **AP-010 (Modular Monolith + Ports & Adapters):** Границы между UI, Host, Runner и Policy разделены через узкие порты и контракты.
  - **AP-014 (SOLID & Clean Code):** Файлы имеют единую ответственность (`resolver.ts`, `store.ts`, `schema.ts`, `child-turn-guard.ts`).
  - **AP-015 (DRY, KISS, YAGNI):** Отсутствуют избыточные кастомные планировщики или дублированные каталоги моделей.
  - **AP-017 (Data Minimization):** Экспортируются только необходимые поля политики и профилей.
  - **AP-018 (Clarity & Single Responsibility):** Логика доставки вынесена из `session.ts` в `session-subagent-handler.ts` и `session-reconcile.ts`.
  - **AP-019 (File Line Budgets):** Все новые и изменённые файлы строго < 200 строк.
  - **AP-024 (Observability):** Все ошибки и отклонения снабжены диагностическими сообщениями и типизированными кодами.
  - **AP-025 (Import Discipline):** Зависимости направлены внутрь, циклические импорты отсутствуют.
  - **AP-027 (Configuration & Startup Fail-Fast):** Асинхронная гидратация хранилища выполняется до регистрации провайдера.
  - **AP-028 (Testing Strategy & Determinism):** 395 автоматических тестов без сетевых I/O и flaky-ожиданий.
  - **AP-029 (TypeScript Strictness):** Отсутствуют новые нетипизированные `any` в доменных и контрактных слоях.
  - **AP-033, AP-034, AP-035 (Data Integrity, Concurrency, Idempotence):** FIFO-очередь, CAS по ревизии, persist-before-cache.
  - **AP-047 (Reliable Side Effects):** Snapshot политики фиксируется в `SubagentsDoc` до запуска ребёнка.

- **Failed (Blocking Defects):**
  - **AP-012, AP-016, AP-026 (Fail-Fast, Authoritative Security Boundary, DTO Boundaries):** Нарушено в `child-turn-guard.ts` (P1 — fail-open при холодном зеркале из-за несовпадения DTO ответа `get_state`).
  - **AP-011, AP-020, AP-048 (Low Coupling, Clean Architecture Boundaries, ID Alignment):** Нарушено в `child-turn-guard.ts` / `bridge-router.ts` (P1 — ошибочная классификация ручных субтредов BB как зеркал, пропуск доставки политики и компакшн).
  - **AP-013, AP-026 (Data Integrity Without Fallbacks, DTO Contracts):** Нарушено в `use-catalog-preview.ts` (P2 — вымышленный `hostId: 'default'`).
  - **AP-023, AP-027 (Async Discipline, Lifecycle):** Нарушено в `use-catalog-preview.ts` (P2 — фиктивный `AbortController`).
  - **AP-022 (UI State Determinism):** Нарушено в `settings-subagent-section.tsx` (P2 — потеря черновика режима при сохранении).

- **Residual Risk:**
  - При холодном старте хоста с существующими незавершёнными subagent conversations переопределение модели дочернего треда может не заблокироваться до устранения дефекта P1 в `child-turn-guard.ts`.
  - Ручные дочерние треды, запущенные через интерфейс BB, не обновят политику субагентов до устранения дефекта P1 в `isChildTurn`.

---

## 4. Итоговый вердикт

**VERDICT: FAIL**

### Краткий список блокирующих находок:
1. **[P1]** Fail-open блокировки модели/рассуждений субагента при холодном зеркале из-за обращения к несуществующим полям `res.state.agent` / `res.agent` вместо `res.model` в `child-turn-guard.ts:98-113`.
2. **[P1]** Ошибочная классификация ручных BB-субтредов как child mirrors по одному флагу `parentThreadId`, ведущая к пропуску `reconcileSessionOptions` (политика не доставляется) и блокировке `/compact` в `bridge-router.ts:43-111` / `child-turn-guard.ts:56-59`.
3. **[P2]** Использование синтетического идентификатора `hostId: 'default'` и избыточных optional-проверок в `use-catalog-preview.ts:32-47`, ломающих опрос каталога на стандартных инсталляциях BB.
4. **[P2]** Отсутствие фактического вызова `abort()` у `AbortController` в `use-catalog-preview.ts:63`.
5. **[P2]** Отсутствие блокировки переключения радио-кнопок режима во время `isSaving` в `settings-subagent-section.tsx:94-124`.

Архитектурный фундамент (CAS, очереди, тонкий адаптер, DTO схем, персистентность, упаковка runner и бюджет строк) выполнен качественно, однако наличие двух воспроизводимых P1 дефектов и трёх P2 дефектов в граничных слоях требует точечного исправления перед допуском кандидата к релизу.

---

## 5. Targeted Closure: Верификация исправлений исходных находок

- **Дата верификации:** 2026-10-25
- **Проверенные коммиты исправлений:** `8cce858`, `9416d0d` (HEAD `563ae2c`, receipt `accepted-policy-verification.json` на `ee1d2cc`)
- **Контур проверки:** целевая верификация закрытия исходных блокирующих находок [P1-1], [P1-2], [P2-1], [P2-2], [P2-3] без изменения других файлов репозитория.

### Результаты проверки закрытия исходных находок

#### 1. Закрытие [P1-1]: Cold mirror DTO mismatch & fail-closed validation
- **Проверка в коде:**
  - В `src/host/child-turn-guard.ts` (строки 107–123) устранены обращения к несуществующим полям `(res as any)?.state?.agent ?? (res as any)?.agent`. Обработчик `session.runner.requestOk` декодирует плоские поля `payload.model` (`provider`, `modelId`/`id`) и `payload.thinkingLevel`, возвращаемые `handleSessionStateCommand` из `session-state-commands.ts`.
  - Порт вызова типизирован строго как `runner?: { requestOk: (cmd: Record<string, unknown>) => Promise<unknown> }` вместо `Promise<any>`.
  - Реализован строгий **fail-closed** контракт: если модель или уровень thinking не могут быть извлечены из раннера (сбой связи, повреждённый стейт), запрос на override отклоняется кодом `-32602` (`CHILD_MODEL_POLICY_LOCKED: Could not resolve subagent child thread model...`).
  - Добавлена проверка `targetConversationId !== ROOT_CONVERSATION_ID_STR`: дочерняя валидация никогда не откатывается к корневой беседе и не читает параметры root вместо ребёнка.
- **Воспроизводимое свидетельство:**
  - `tests/host-mirror-guard-repro.test.ts` (тесты `validateChildTurn: parses flat runner DTO and blocks model override on cold mirror`, `fails closed when runner state fetch fails`, `checks thinking level when model is cached but thinking is missing` — все PASS).
  - Прямой запуск adversarial скрипта подтверждает: попытка переопределения модели дочернего треда на Claude 3.7 Sonnet при холодном зеркале блокируется с ошибкой:
    `CHILD_MODEL_POLICY_LOCKED: Subagent child thread model (antigravity/gemini-3.8-flash) cannot be overridden with (anthropic/claude-3-7-sonnet)`.
- **Статус:** **ЗАКРЫТО (CLOSED)**.

#### 2. Закрытие [P1-2]: Независимые ручные субтреды BB против нативных child mirrors
- **Проверка в коде:**
  - В `src/host/bridge-router.ts` (строки 44–46) сначала выполняется `await ctx.registry.createOrGet(...)`, и только затем проверяется `isChildTurn(params, session)`.
  - В `src/host/child-turn-guard.ts` (строки 53–72) функция `isChildTurn` больше не классифицирует сессию как дочернюю только по признаку наличия `params.parentThreadId`. Если сессия является владельцем своего треда (`session.options.threadId === params.threadId`) и не привязана к композитному не-root идентификатору или дочерней беседе, `isChildTurn` возвращает `false`.
  - Использована константа `ROOT_CONVERSATION_ID` из `@earendil-works/pi-durable` (для Pi 1.3.0 равна `1`). Идентификатор `ROOT_CONVERSATION_ID` в `session-owner.ts` и `child-turn-guard.ts` трактуется как корневой, а не как дочерний subagent task.
  - В результате ручные субтреды BB (`bb thread spawn` или создание подтреда в UI) штатно получают `reconcileSessionOptions(session, params.options, params.providerOptions)`, благодаря чему актуальная политика `subagentPolicy` и настройки модели доставляются в раннер через `set_subagent_policy`.
  - Для независимых ручных тредов команда `/compact` выполняется в полном объёме, а не блокируется ошибкой `-32602`. Настоящие нативные дочерние зеркала по-прежнему надёжно изолированы и не могут мутировать родительскую сессию.
- **Воспроизводимое свидетельство:**
  - `tests/host-mirror-guard-repro.test.ts` (тесты `isChildTurn: manual BB subthread with parentThreadId is NOT a child if it has its own root session` и `isChildTurn and detectNativeChild: explicit ROOT_CONVERSATION_ID in composite ID is not a child` — PASS).
  - Прямой запуск adversarial скрипта для ручного субтреда подтверждает `isChildTurn: false`.
- **Статус:** **ЗАКРЫТО (CLOSED)**.

#### 3. Закрытие [P2-1]: Исключение вымышленного `hostId: 'default'` и старых проверок SDK
- **Проверка в коде:**
  - В `src/ui/use-catalog-preview.ts` (строки 38–68) удалены условные зондирования `sdk.system?.config ? ...`. Код напрямую вызывает гарантированные контрактом SDK 0.6.79 методы `sdk.system.config()`, `sdk.hosts.list()` и `sdk.environments.list()`.
  - Удалён синтетический fallback `hostId: "default"`. Если в системе нет удалённых хостов или окружений, `initial` устанавливается в `null`, `routing` остаётся `null`, а запрос `sdk.providers.models` с фиктивным хостом не выполняется.
  - В `src/ui/settings-subagent-section.tsx` при `!routing` выводится понятное сообщение «Нет доступных хостов или окружений для предпросмотра моделей». Режим `inherit` при этом сохраняется без ошибок. Флаг `canSaveConfigured` блокируется при наличии `catalogError` или `modelLoadError`.
- **Воспроизводимое свидетельство:**
  - `tests/ui/ui-settings-fixes.test.ts` (тесты `empty hosts and null primaryHostId sets routing to null without fake default` и `canSaveConfigured is blocked when modelLoadError is present` — PASS).
- **Статус:** **ЗАКРЫТО (CLOSED)**.

#### 4. Закрытие [P2-2]: Реальная отмена устаревших запросов через AbortController
- **Проверка в коде:**
  - В `src/ui/use-catalog-preview.ts` (строки 30, 74–133) добавлен `activeAbortRef = useRef<AbortController | null>(null)` и `isMountedRef`.
  - При смене `routing` предыдущий контроллер явно отменяется через `activeAbortRef.current?.abort()`.
  - Новый `AbortController` создаётся на каждый запуск загрузки, передаётся в `sdk.providers.models` и отменяется в функции очистки `useEffect`. При размонтировании компонента контроллер также вызывается с `abort()`.
  - Модели и ошибки предыдущего маршрута очищаются мгновенно (`setModels([])`, `setModelLoadError(null)`), что исключает отображение и сохранение устаревшего каталога во время перехода.
  - Событие `AbortError` перехватывается и не порождает ложных ошибок каталога.
- **Воспроизводимое свидетельство:**
  - `tests/ui/ui-settings-fixes.test.ts` (тест `AbortController aborts in-flight catalog query on route change and unmount` — PASS).
- **Статус:** **ЗАКРЫТО (CLOSED)**.

#### 5. Закрытие [P2-3]: Защита пользовательского ввода режима при сохранении политики
- **Проверка в коде:**
  - В `src/ui/settings-subagent-section.tsx` (строки 95, 106) радио-кнопки переключения режима (`inherit` / `configured`) получили атрибут `disabled={isSaving}`.
  - В `src/ui/use-subagent-policy.ts` (строки 49–65) `save()` фиксирует снимок `snapshotToSave = draftPolicy`. По завершении асинхронного RPC-вызова `setDraftPolicy` обновляет черновик серверным значением только в том случае, если текущий черновик идентичен сохранённому снимку:
    ```ts
    setDraftPolicy((currentDraft) => {
        if (currentDraft && JSON.stringify(currentDraft) === JSON.stringify(snapshotToSave)) {
            return res.record.policy;
        }
        return currentDraft;
    });
    ```
- **Воспроизводимое свидетельство:**
  - `tests/ui/ui-settings-fixes.test.ts` (тест `radio inputs are disabled while isSaving is true` — PASS).
- **Статус:** **ЗАКРЫТО (CLOSED)**.

---

## 6. Финальная сводка верификации

1. **Unit & Integration тесты:** 395 тестов Node.js + 9 тестов UI (всего 404 теста) — **0 failures, 100% PASS**.
2. **TypeScript Strict Typecheck (`npx tsc --noEmit`):** exit code 0, 0 ошибок.
3. **Runner Packaging & Zod Externalization:** размер бандла `dist/runner/index.js` составляет **143,947 байт** (норматив < 200 КБ соблюдён, тест упаковки `runner-packaging.test.ts` PASS).
4. **Line Budget (AP-019):** Все 8 затронутых production-файлов строго короче 200 строк (максимальный размер — 196 строк в `bridge-router.ts`).
5. **Contract Invariant (SDK 0.6.79 & Pi 1.3.0):** Константа `ROOT_CONVERSATION_ID: 1` строго согласована с `@earendil-works/pi-durable`. SDK `bb plugin types --check` exit 1 является задокументированным отклонением (SDK остаётся в production dependencies для работы изолированного моста провайдера).
6. **Live Runtime Notice:** Данное ревью подтверждает готовность кода в репозитории; live runtime существующих тредов не переключался. Установка/обновление выполняется отдельной процедурой; это ревью не предписывает перезапуск BB или хоста.

---

## Итоговый вердикт после закрытия находок

# **VERDICT: PASS**


