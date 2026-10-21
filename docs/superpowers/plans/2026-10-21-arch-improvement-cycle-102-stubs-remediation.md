# Arch Improvement Cycle 102: Provider Stubs, Truncated Logic & Parity Remediation

**Goal:** Устранить выявленные при глубоком архитектурном аудите скрытые заглушки, дефолты и обрезанную логику:
1. Восстановить смену модели и уровня рассуждений на лету в `turn/start` и `turn/steer` (F-102-1).
2. Реализовать проброс настроенных корней навыков из `skills/configure` в раннер через `--skill` и `additionalSkillPaths` (F-102-2).
3. Заменить пустую заглушку `resolveNativeRoots: () => ({ skills: [] })` на канонический резолвер нативных навыков Pi (F-102-3).
4. Заменить захардкоженные `reasoningEfforts` в `ModelCatalog.listModels()` на динамический вывод из возможностей модели `reasoning` / `thinkingLevelMap` (F-102-4).
5. Наполнить реальными сообщениями хуки `session_before_compact` и связать `ExtensionContextActions` (`abort`, `compact`, `getContextUsage`) с рантаймом Durable (F-102-5, F-102-6).

## Architecture Context Map
- `src/host/bridge-router.ts` & `src/host/session.ts` — маршрутизация смены модели/thinking на активной сессии.
- `src/host/bridge.ts` & `src/host/session-registry.ts` & `src/host/session-telemetry.ts` — сохранение и проброс `skills/configure`.
- `src/host/index.ts` & `server.ts` — канонический резолвер нативных корней навыков (`resolveNativeRoots`) и рекурсивные манифесты.
- `src/host/catalog.ts` — динамические `supportedReasoningEfforts` по метаданным модели.
- `src/runner/cli-args.ts` & `src/runner/runtime-loader.ts` — парсинг `--skill` и передача в `DefaultResourceLoader`.
- `src/runner/extension-bridge.ts` & `src/runner/runtime-controller.ts` — наполнение `messages` в хуке компакта и связывание `abort/compact/contextUsage`.
- `tests/cycle-102-stubs-remediation.test.ts` — TDD тесты для верификации устраненных заглушек.

## Triage
- `fix-now`:
  - **F-102-1**: Смена модели и thinking level в `handleTurnStart` (`src/host/bridge-router.ts`, `src/host/session.ts`).
  - **F-102-2**: Обработка `skills/configure` и проброс `--skill` в раннер (`src/host/bridge.ts`, `src/host/session-telemetry.ts`, `src/runner/cli-args.ts`, `src/runner/runtime-loader.ts`).
  - **F-102-3**: Канонический `resolveNativeRoots` и рекурсивные корни в `server.ts` (`src/host/index.ts`, `server.ts`).
  - **F-102-4**: Динамический расчет `supportedReasoningEfforts` в `ModelCatalog` (`src/host/catalog.ts`).
  - **F-102-5 & F-102-6**: Живые сообщения в `session_before_compact` и `contextActions` (`src/runner/runtime-controller.ts`, `src/runner/extension-bridge.ts`).
- `log-only`: нет.
- `blocked`: нет.

## Step-by-Step Implementation Slices

### Slice 1: Mid-Session Model & Reasoning Switch (F-102-1)
- [ ] В `src/host/session.ts` добавить методы `setModel(provider: string, id: string)` и `setThinkingLevel(level: string)` через `this.runner.requestOk(...)`.
- [ ] В `src/host/bridge-router.ts` в `handleTurnStart` проверять изменение `options.model` и `options.reasoningLevel` относительно текущей сессии и вызывать `setModel` / `setThinkingLevel`.
- [ ] Проверить лимиты строк (AP-019 < 200).

### Slice 2: Skills Configuration and Native Roots Parity (F-102-2 & F-102-3)
- [ ] В `src/host/bridge.ts` в `case "skills/configure"` сохранять `params.roots` в `SessionRegistry.sharedSkillRoots`.
- [ ] В `src/host/session-telemetry.ts` в `buildRunnerArgs` передавать `--skill` для каждого пути из `sharedSkillRoots`.
- [ ] В `src/runner/cli-args.ts` добавить парсинг повторяющихся флагов `--skill <path>` в `args.skills`.
- [ ] В `src/runner/runtime-loader.ts` передавать `additionalSkillPaths: options.cli.skills` в `DefaultResourceLoader`.
- [ ] В `server.ts` объявить рекурсивные объекты для `experimental_nativeSkillRoots` (`recursive: true`, `ancestors: true`).
- [ ] В `src/host/index.ts` реализовать канонический `resolveNativeRoots` с обнаружением навыков в `~/.pi/agent/skills`.
- [ ] Проверить лимиты строк (AP-019 < 200).

### Slice 3: Dynamic Model Catalog Capabilities (F-102-4)
- [ ] В `src/host/catalog.ts` проверять `m.reasoning`: если `false` — возвращать пустой массив или `["none"]`, если `true` — выводить поддерживаемые уровни на основе `thinkingLevelMap`.
- [ ] Проверить лимиты строк (AP-019 < 200).

### Slice 4: Context Actions & Real Compaction Payload (F-102-5 & F-102-6)
- [ ] В `src/runner/runtime-controller.ts` в `compact()` извлекать реальные сообщения из текущего контекста и передавать их в `session_before_compact` (`messagesToSummarize`, `branchEntries`).
- [ ] В `src/runner/extension-bridge.ts` связать методы `abort`, `compact`, `getContextUsage` с реальными действиями.
- [ ] Проверить лимиты строк (AP-019 < 200).

### Slice 5: TDD Tests, Verification & Review
- [ ] Создать `tests/cycle-102-stubs-remediation.test.ts`.
- [ ] Прогнать полный сьют: `npm test` (все тесты зеленые).
- [ ] Собрать раннер и хост: `npm run build`.
- [ ] Провести двухконтурный гейт S9 (Architecture Review + Product Review).
- [ ] Обновить `docs/arch-improvement/ledger.md`.
