# Arch Improvement Cycle 103: v0.5.0 — Public Library `durable-zero` & 100% Codemode Parity

**Cycle:** 103  
**Target Release:** v0.5.0  
**Date:** 2026-11-02  
**Status:** S6 PLAN WRITE  
**Goal:** Выделение суверенного ядра агентов в публичный репозиторий и open-source библиотеку `durable-zero` (MIT License, zero-leak Ports & Adapters, Unix Domain Socket Daemon), устранение 2 дефектов паритета `codemode` (BL-CM-09, BL-CM-10) и перевод `bb-plugin-provider-pi-durable` на архитектуру тонкого потребителя (Consumer Adapter).  
**Orchestration Contract:** `~/Projects/AGENTS.md`  
**Governing Skills & Rules:**
- `~/Projects/arch-improvement-skills/skills/arch-improvement-loop/SKILL.md` (Strict FSM S0–S11)
- `~/Projects/arch-improvement-skills/skills/arch-improvement-review/SKILL.md`
- `~/Projects/arch-rules-skills/skills/arch-rules-implementation-review/SKILL.md`
- `~/Projects/arch-rules-skills/skills/arch-rules-slice-planning/SKILL.md`
- `~/Projects/arch-rules/arch-rules.md` (AP-010, AP-011, AP-012, AP-013, AP-014, AP-019, AP-020, AP-023, AP-025, AP-026, AP-028, AP-029, AP-045, AP-047)
**Context Docs:**
- `docs/arch-improvement/audits/2026-11-02-codemode-upstream-parity-audit.md`
- `docs/superpowers/specs/2026-11-02-durable-zero-sovereign-core-roadmap.md`

---

## 1. Context Map Reference (S2)

- **Stage:** `prod` (runtime активен в Beyond Boundaries; ядро выделяется в публичную библиотеку).
- **Source docs:**
  - Upstream Pi: `/Users/vanya/Projects/pi` (packages: `coding-agent`, `durable`, `codemode`)
  - Audits: `docs/arch-improvement/audits/2026-11-02-codemode-upstream-parity-audit.md`
- **Active paths:**
  - `src/runner/` + `src/contracts/` $\to$ выделяются в `~/Projects/durable-zero`
  - `src/host/` + `src/ui/` $\to$ остаются в `bb-plugin-provider-pi-durable`
- **Critical AP gates:**
  - AP-010: Strict Ports & Adapters (durable-zero не знает о Beyond Boundaries)
  - AP-011: Thin Adapter Invariant (хост-адаптер только транслирует протокол)
  - AP-012: Domain purity and typed errors
  - AP-013 / AP-028: Explicit timeouts on all commands and tests
  - AP-014: GoF lifecycle management (PluginRegistry teardownAll)
  - AP-019: Line budgets (< 250 LOC per .ts file)
  - AP-020: Composition Root
  - AP-023: Resource teardown (Sockets, Workers, Locks)

---

## 2. Triaged Findings (S5)

### Fix Now:
- **BL-CM-09 (P2):** Маппинг `exposure: "codemode"` (Slice 1).
- **BL-CM-10 (P2):** Универсальные пространства имён `DynamicCodemodeNamespaces` (Slice 2).
- **BL-DZ-01 (P1):** Unix Domain Socket Server / Client Proxy (`SessionDaemon`) (Slice 3).
- **BL-DZ-02 (P1):** Инициализация монорепозитория `~/Projects/durable-zero` (Slice 4).
- **BL-DZ-03 (P1):** Перенос пакетов ядра и контрактов в `durable-zero` (Slice 5).
- **BL-DZ-04 (P1):** Публичный Standalone CLI `durable-zero` (Slice 6).
- **BL-DZ-05 (P1):** Перевод `bb-plugin-provider-pi-durable` на потребление `durable-zero` (Slice 7).

### Log Only:
- **BL-CM-11 (P3):** Устаревший алиас `codemode-deferred` (сохранить защитный fallback в парсере).
- **BL-CM-12 (P3):** Отсутствие `aliases` в `CodemodeNamespace` ядра Durable (ограничение upstream).

---

## 3. Implementation Slices (TDD Red -> Green -> Verify -> Commit)

### Slice 1: Восстановление видимости `exposure: "codemode"` в промпте (BL-CM-09)
- **Boundary:** Domain / Adapter (`src/runner/tool-adapter.ts`)
- **AP gates:** AP-010, AP-011, AP-019, AP-028
- **Red test first:** `tests/codemode-exposure-prompt.test.ts`.  
  Зарегистрировать инструмент с `exposure: "codemode"`.  
  Проверить:
  1. `reg.callers` строго `["tools"]`.
  2. `reg.deferred` строго `undefined` (или `false`).
  3. `codemodeSection([reg], [], 3000)` включает имя и TypeScript-сигнатуру инструмента.  
  *Ожидаемый провал:* тест падает, так как в текущем коде `isDeferred = true`, и `codemodeSection` вырезает инструмент.
- **Minimal implementation:** В `src/runner/tool-adapter.ts:55`:
  ```ts
  const isDeferred = exposure === "deferred";
  const callers =
      exposure === "model-only" ? (["model"] as const)
      : exposure === "codemode" || exposure === "codemode-deferred" ? (["tools"] as const)
      : exposure === "hidden" ? ([] as const)
      : (["model", "tools"] as const);
  ```
- **Verification:** `node --test tests/codemode-exposure-prompt.test.ts` (PASS), `wc -l src/runner/tool-adapter.ts` (< 250 LOC).
- **Commit:** `fix(runner): ensure codemode exposed tools are listed in codemode prompt section (BL-CM-09)`

---

### Slice 2: Универсальные пространства имён в `DynamicCodemodeNamespaces` (BL-CM-10)
- **Boundary:** Domain / Adapter (`src/runner/codemode-namespaces.ts`)
- **AP gates:** AP-011, AP-014, AP-019, AP-028
- **Red test first:** `tests/universal-namespaces.test.ts`.  
  Передать инструмент `database_query` с `namespace: { name: "database", description: "Database ops", instructions: "Use SQL" }`.  
  *Ожидаемый провал:* `getNamespaces()` пуст, так как имя инструмента не подходит под regex `/^mcp__*__/`.
- **Minimal implementation:** В `src/runner/codemode-namespaces.ts`:
  Если у инструмента объявлен `def.namespace?.name`, регистрировать его независимо от префикса:
  ```ts
  if (def.namespace?.name) {
      const name = def.namespace.name;
      const prefix = def.name.startsWith(`${name}__`)
          ? `${name}__`
          : def.name.startsWith(`${name}_`)
              ? `${name}_`
              : `${name}:`;
      this.registerNamespace({
          name,
          prefix,
          ...(def.namespace.description ? { description: def.namespace.description } : {}),
          ...(def.namespace.instructions ? { instructions: def.namespace.instructions } : {}),
      });
  }
  ```
- **Verification:** `node --test tests/universal-namespaces.test.ts` (PASS), `wc -l src/runner/codemode-namespaces.ts` (< 250 LOC).
- **Commit:** `fix(runner): support universal tool namespaces for non-mcp extensions (BL-CM-10)`

---

### Slice 3: Сервер сокет-демона сессии (`SessionDaemon`) (BL-DZ-01)
- **Boundary:** Infrastructure / IPC (`src/runner/session-daemon.ts`)
- **AP gates:** AP-010, AP-013, AP-020, AP-023, AP-028
- **Red test first:** `tests/session-socket-daemon.test.ts`.  
  Создать временную директорию сессии. Запустить `SessionDaemon.startMaster()`, который поднимает `runner.sock`.  
  Запустить клиента через `SessionDaemon.connectClient()`. Отправить JSON-RPC ping-запрос, получить pong.  
  *Ожидаемый провал:* модуль `session-daemon.ts` отсутствует.
- **Minimal implementation:** Создать `src/runner/session-daemon.ts`:
  - `startMaster(sessionDir: string, onConnection: (socket: net.Socket) => void)`
  - `tryConnectClient(sessionDir: string, timeoutMs?: number): Promise<net.Socket | null>`
  - Очистка stale-сокетов при старте с проверкой liveness.
  - Интеграция в `src/runner/index.ts`: если сокет активен, раннер переходит в режим transparent IPC proxy.
- **Verification:** `node --test tests/session-socket-daemon.test.ts` (PASS), `wc -l src/runner/session-daemon.ts` (< 250 LOC).
- **Commit:** `feat(runner): implement multi-client unix socket daemon to eliminate session lock contention (BL-DZ-01)`

---

### Slice 4: Инициализация суверенного публичного репозитория `~/Projects/durable-zero` (BL-DZ-02)
- **Boundary:** Project Setup / Monorepo Architecture
- **AP gates:** AP-010, AP-012, AP-013, AP-020
- **Implementation:**
  - Создать `/Users/vanya/Projects/durable-zero`.
  - Инициализировать `git init`.
  - Добавить `package.json` (MIT, "name": "durable-zero", "type": "module", pnpm workspace).
  - Настроить `pnpm-workspace.yaml` (`packages/*`).
  - Добавить запись в `~/Projects/registry.json` (category: "harness", status: "active", one_liner: "Sovereign ACID-Persisted Agent Runtime and SDK").
  - Добавить `.gitignore`, `tsconfig.base.json`, `README.md`, `LICENSE` (MIT).
- **Verification:** `cd /Users/vanya/Projects/durable-zero && pnpm -v && git status`.
- **Commit:** `feat(init): scaffold sovereign durable-zero monorepo`

---

### Slice 5: Перенос пакетов ядра, контрактов и плагинов в `durable-zero` (BL-DZ-03)
- **Boundary:** Architecture Decoupling (Hexagonal Architecture)
- **AP gates:** AP-010 (Zero `@get-bb/*` leaks), AP-011, AP-014, AP-019
- **Implementation:**
  - `packages/contracts/`: чистые интерфейсы и схемы DTO (`src/contracts/*`).
  - `packages/sdk/`: `DurablePlugin`, `DurablePluginRegistry`, `DurablePluginContext` (`src/runner/plugins/types.ts, registry.ts`).
  - `packages/plugins/`: встроенные плагины `coding-tools`, `codemode`, `subagents`.
  - `packages/core/`: `DurableEngine`, `SessionDaemon`, рантайм-загрузчик, TaskGraph, SQLite-адаптеры.
- **Verification:** `cd /Users/vanya/Projects/durable-zero && pnpm build && pnpm test`.
- **Commit:** `feat(core): transfer sovereign runner core, sdk, and contracts into durable-zero`

---

### Slice 6: Реализация публичного Standalone CLI (BL-DZ-04)
- **Boundary:** Public Entrypoint / CLI
- **AP gates:** AP-010, AP-011, AP-012, AP-013, AP-028
- **Red test first:** `packages/cli/test/cli.test.ts`.  
  Запустить `node bin/durable-zero.js --version` и `node bin/durable-zero.js doctor`.  
  *Ожидаемый провал:* исполняемый файл отсутствует.
- **Minimal implementation:**
  - `packages/cli/bin/durable-zero.js`:
    - `run <prompt>`: одноразовое выполнение задачи с сохранением сессии в `~/.durable/sessions/<id>`.
    - `serve [--session <id>]`: запуск stdio/socket демона.
    - `doctor`: диагностика доступности SQLite, QuickJS WASM, сетевых адаптеров.
- **Verification:** `cd /Users/vanya/Projects/durable-zero && node packages/cli/bin/durable-zero.js doctor`.
- **Commit:** `feat(cli): implement standalone durable-zero command line runner`

---

### Slice 7: Перевод `bb-plugin-provider-pi-durable` на тонкий потребитель (BL-DZ-05)
- **Boundary:** Host Adapter Migration
- **AP gates:** AP-010, AP-011, AP-019, AP-028
- **Implementation:**
  - В `bb-plugin-provider-pi-durable/package.json` добавить `"durable-zero": "link:../durable-zero"`.
  - В `src/host/runner-process.ts` переключить запуск на бинарник `durable-zero serve`.
  - Удалить локальную директорию `src/runner/` из `bb-plugin-provider-pi-durable`.
  - Обновить `scripts/build-runner.mjs`.
- **Verification:** Запуск всех 751+ тестов в `bb-plugin-provider-pi-durable`: `npm test` (PASS).
- **Commit:** `refactor(host): migrate bb provider to consume external durable-zero runtime (BL-DZ-05)`

---

## 4. S9 Verify Gate: Two-Circuit Verification

Перед присвоением тега v0.5.0:
1. **Контур 1 (Архитектурный фаервол и AP rules):**
   - В `durable-zero`: 0 импортов `@get-bb/*`, MIT лицензия, отсутствие персональных путей.
   - В `bb-plugin-provider-pi-durable`: `scripts/verify-layer-boundaries.mjs` (0 нарушений).
   - Лимиты строк: все файлы строго < 250 LOC (AP-019).
2. **Контур 2 (Продуктовый контроль и регрессия):**
   - Полный сьют тестов `bb-plugin-provider-pi-durable` (751+ pass).
   - Изолированные тесты `durable-zero` (100% pass).
   - Проверка `doctor.mjs` (HEALTHY).
   - Запуск субтреда без `SESSION_OWNER_CONFLICT` через сокет-демон.

---

## 5. S10 Ledger Update & S11 Learn Gate
- Обновить версию в `package.json` до `0.5.0`.
- Записать итоговый чек-ин в `docs/arch-improvement/ledger.md` (секция Cycle 103).
- Зафиксировать уроки в `docs/arch-improvement/memory.md`.
- Создать релизный тег `v0.5.0` и запушить в GitHub.
