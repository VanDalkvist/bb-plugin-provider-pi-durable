# Отчёт об исправлении интеграционной регрессии и бюджетных нарушений

**Дата:** 2026-10-26  
**Рабочее дерево:** `/Users/vanya/Projects/bb-plugin-provider-pi-durable`  
**Исполнитель:** Нативный subagent (интеграционный remediator)  
**Артефакты в thread-storage:**
- План исправлений: `/Users/vanya/.bb/thread-storage/thr_ct3kk9xne6/integration-regression-fix-plan.md`
- Сравнение инвентаря тестов: `/Users/vanya/.bb/thread-storage/thr_ct3kk9xne6/integration-regression-fix-test-inventory.md`
- Лог Source TSC: `/Users/vanya/.bb/thread-storage/thr_ct3kk9xne6/integration-regression-fix-source-tsc.log`
- Лог Contract Compiler & Negative Guard: `/Users/vanya/.bb/thread-storage/thr_ct3kk9xne6/integration-regression-fix-contract-compiler.log`
- Лог Full NPM Test: `/Users/vanya/.bb/thread-storage/thr_ct3kk9xne6/integration-regression-fix-npm-test.log`
- Лог Import AST SCC: `/Users/vanya/.bb/thread-storage/thr_ct3kk9xne6/integration-regression-fix-import-scc.log`
- Лог AP-019 Line Counts: `/Users/vanya/.bb/thread-storage/thr_ct3kk9xne6/integration-regression-fix-line-counts.log`
- Лог NPM Build (Dist): `/Users/vanya/.bb/thread-storage/thr_ct3kk9xne6/integration-regression-fix-npm-build.log`

---

## Итоговый вердикт

# **VERDICT: PASS**

Все дефекты из независимого интеграционного отчёта `integrated-verification.md` устранены в полном объёме:
1. **[P1 Регрессия тестов] Устранена:** Все 9 ранее падавших интеграционных тестов успешно проходят (`496 pass, 0 fail` в базовом раннере + `501 pass, 0 fail` с учётом новых тестов + `9 pass, 0 fail` UI).
2. **[P2 Бюджет строк AP-019] Устранено:** `tests/runtime-graph-source.test.ts` (390 строк) и `tests/session-admission-race.test.ts` (239 строк) разделены на сценарии; все тронутые и новые файлы строго < 200 строк.
3. **[Dist Ownership]** Сборка `npm run build` выполнена успешно (актуализированы артефакты `dist/runner/index.js`, `dist/server.js`, `dist/app.js`, `dist/host.js`).

---

## 1. Сводная матрица проверок

| # | Проверка | Точная команда | Exit code | Результат / Метрики | Лог в thread-storage |
|---|---|---|---|---|---|
| 1 | **Source TSC** | `npx tsc --noEmit` | `0` | **PASS**: 0 ошибок компиляции во всех файлах `src/**/*`, `server.ts`, `app.tsx` | `integration-regression-fix-source-tsc.log` |
| 2 | **Contract compiler & negative guard** | `npm run test:contracts` | `0` | **PASS**: `tsc --noEmit -p tsconfig.contract-tests.json` чисто; negative fixture guard подтверждает отказ компилятора `TS2322` | `integration-regression-fix-contract-compiler.log` |
| 3 | **Full npm test suite** | `npm test` | `0` | **PASS**: 510 тестов (501 node:test + 9 UI tsx), 26 сьютов: **510 pass, 0 fail** | `integration-regression-fix-npm-test.log` |
| 4 | **Import AST SCC** | `node scripts/verify-import-graph.mjs && node --test tests/import-graph.test.ts` | `0` | **PASS**: 123 файла `src/`, 0 циклов (Tarjan SCC), 2 теста оракула пройдены | `integration-regression-fix-import-scc.log` |
| 5 | **AP-019 Line Budgets (< 200)** | Скрипт подсчёта строк | `0` | **PASS**: Все 9 тронутых и новых файлов строго < 200 строк. Все файлы `src/` (23/23) строго < 200 строк. | `integration-regression-fix-line-counts.log` |
| 6 | **Build Artifacts (dist)** | `npm run build` | `0` | **PASS**: Все бандлы (`dist/runner/index.js`, `dist/server.js`, `dist/app.js`, `dist/host.js`) пересобраны | `integration-regression-fix-npm-build.log` |

---

## 2. Анализ и устранение дефектов (Findings)

### Finding 1 [P1] Регрессия `SESSION_IDENTITY_MISMATCH` в `SessionRegistry.createOrGet` / `handleTurnStart`
- **Проблема:**  
  Предыдущее исправление Admission Finding 3 ввело blanket-проверку `parentKey !== sessionKey` при допуске дочернего субтреда к сессии родителя. В Beyond Boundaries дочерний субтред получает собственный сгенерированный `providerThreadId` (и, соответственно, отличный от родителя `sessionKey`), что является легитимным alias-идентификатором в иерархии BB. Кроме того, при вызове `turn/start` без `params.providerThreadId` генерировался фиктивный `pi_durable_${Date.now()}`, что ломало повторные ходы и мультимодальные вызовы на уже зарегистрированных сессиях.
- **Исправление:**
  1. Выделен узкий host binding helper `src/host/session-binding.ts` (`SessionBindingTracker`, 84 строки):
     - Отслеживает привязки `threadId -> providerThreadId` (alias).
     - Метод `validateExistingThread`: для корневого треда строго требует совпадения `requestedKey === rootKey` (защита от same-thread identity replacement); для дочернего субтреда валидирует соответствие его alias либо rootKey.
     - Метод `validateChildAttachment`: для составных ID (`conversationId !== undefined`) строго требует совпадения `childKey === parentKey` (защита от hostile wrong-root mismatch); для простых alias-идентификаторов разрешает легитимное подключение, если `childKey` не совпадает с ключом другой активной корневой сессии.
  2. В `src/host/bridge-router.ts`: при отсутствии `params.providerThreadId` в `turn/start` разрешается объявленная идентичность треда (`ctx.registry.getBoundProviderThreadId(threadId) ?? existing?.options.providerThreadId`), исключая генерацию конфликтующих временных меток.
  3. В `src/host/session-port.ts`: расширен интерфейс `SessionRegistryPort` методом `getBoundProviderThreadId?(threadId: string): string | undefined`.
  4. В `src/host/session-registry.ts`: валидация делегирована в `SessionBindingTracker`; сохранен single writer и mutex-допуск.
- **Результаты 9 падавших ранее тестов (все GREEN):**
  1. `tests/host-subthread-shared-session.scenarios-2.test.ts:13` — **PASS**
  2. `tests/host-subthread-shared-session.test.ts:13` — **PASS**
  3. `tests/host-subthread-shared-session.test.ts:59` — **PASS**
  4. `tests/host-subthread-shared-session.test.ts:122` — **PASS**
  5. `tests/multimodal-bridge-e2e.test.ts:12` — **PASS**
  6. `tests/subagent-early-completion-race.test.ts:10` — **PASS**
  7. `tests/subagent-live-mirror-e2e.test.ts:12` — **PASS**
  8. `tests/subagent-mirror-stream-and-turn-open.test.ts:70` — **PASS**
  9. `tests/subagent-mirror-stream-and-turn-open.test.ts:112` — **PASS**
- **Добавлены новые регрессионные тесты:** `tests/session-identity-guard.test.ts` (5/5 pass):
  - Проверка легитимного подключения дочернего субтреда со своим alias.
  - Проверка rejection при составном `providerThreadId` чужой сессии (`pi_other:2`).
  - Проверка rejection при попытке использовать ключ чужой активной сессии.
  - Проверка rejection при same-thread identity replacement на корневом треде.
  - Проверка rejection при попытке дочернего треда переключиться на чужую сессию.

---

### Finding 2 [P2] Нарушение бюджета строк AP-019 в тестовых файлах
- **Проблема:**  
  `tests/runtime-graph-source.test.ts` (390 строк) и `tests/session-admission-race.test.ts` (239 строк) превышали лимит < 200 строк.
- **Исправление:**
  1. `tests/runtime-graph-source.test.ts` (176 строк) — тесты 1–4 (проекция задач, защита от голодания при debouncing, лимит 512, дедупликация структурного состояния).
  2. `tests/runtime-graph-source.scenarios-2.test.ts` (184 строки) — тесты 5–7 (сохранение цепочки владельца, исчезновение без receipt, фиксация коммитов Harness).
  3. `tests/session-admission-race.test.ts` (147 строк) — тесты 1–3 (конкурентные start/turn, коалесценция createOrGet, коалесценция root + child).
  4. `tests/session-admission-race.scenarios-2.test.ts` (92 строки) — тесты 4–6 (отклонение официантов при сбое, независимые сессии, остановка во время создания).
- **Инвентарь сохранён на 100%:** 13/13 исходных сценариев сохранены со всеми проверками и ассертами без изменений.

---

## 3. Бюджеты строк всех тронутых и новых файлов (AP-019 Verification)

| Файл | Назначение | Строк | Лимит AP-019 | Статус |
|---|---|---|---|---|
| `src/host/session-binding.ts` | Узкий host binding helper (валидация alias, child, root) | 84 | < 200 | **PASS** |
| `src/host/session-port.ts` | Порты сессий и реестра | 73 | < 200 | **PASS** |
| `src/host/session-registry.ts` | Реестр сессий с интеграцией binding tracker | 192 | < 200 | **PASS** |
| `src/host/bridge-router.ts` | Маршрутизатор хост-бриджа с fallback на bound ID | 185 | < 200 | **PASS** |
| `tests/runtime-graph-source.test.ts` | Первая часть сьюта источника графа (сценарии 1–4) | 176 | < 200 | **PASS** |
| `tests/runtime-graph-source.scenarios-2.test.ts` | Вторая часть сьюта источника графа (сценарии 5–7) | 184 | < 200 | **PASS** |
| `tests/session-admission-race.test.ts` | Первая часть сьюта гонок допуска (сценарии 1–3) | 147 | < 200 | **PASS** |
| `tests/session-admission-race.scenarios-2.test.ts` | Вторая часть сьюта гонок допуска (сценарии 4–6) | 92 | < 200 | **PASS** |
| `tests/session-identity-guard.test.ts` | Регрессионные тесты защиты идентичности и alias | 107 | < 200 | **PASS** |

Все файлы в `src/` (23/23) строго укладываются в лимит AP-019 (< 200 строк).

---

## 4. Архитектурная верификация (AP-010 – AP-071)

- **Passed:**
  - `AP-010` (Модульный монолит + Ports & Adapters): Host binding helper выделен в изолированный порт/адаптер без утечки внутренней структуры раннера.
  - `AP-011` (Низкая связность и высокая когезия): `SessionBindingTracker` отвечает строго за правила идентичности и алиасов BB.
  - `AP-012` (Fail-fast и явные контракты ошибок): Любая нелегитимная попытка подмены корня или чужого сессионного ключа детерминированно падает с `SessionIdentityMismatchError`.
  - `AP-013` (Целостность пользовательских данных): Сохранена изоляция данных между независимыми сессиями; дочерние субтреды безопасно разделяют SQLite БД родителя без конфликта блокировок.
  - `AP-019` (Лимиты размера и смысловое дробление): Все измененные и новые `.ts` файлы строго < 200 строк.
  - `AP-022` (Typed errors): Ошибки типизированы (`SESSION_IDENTITY_MISMATCH`, `SESSION_CREATION_ABORTED`).
  - `AP-025` (Дисциплина импортов): 123 файла, 0 циклов по Tarjan AST SCC.
  - `AP-028` (Стратегия тестирования и детерминизм): Все тесты детерминированы, 510/510 зеленые.
  - `AP-034` (Стратегия конкурентного доступа): Сохранен Single Writer и Mutex admission.
  - `AP-039` / `AP-048` (Auth boundary и соответствие идентификаторов): Соответствие `threadId`, `sessionKey` и `parentThreadId` валидируется с учетом семантики Beyond Boundaries.
- **Residual risk:**
  - Границы живого рантайма Beyond Boundaries (Live UI rendering в Electron-окне и roundtrip сообщений через реальный десктопный процесс) остаются непроверенными live seams до запуска установленного плагина.
