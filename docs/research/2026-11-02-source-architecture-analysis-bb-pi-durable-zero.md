# Исследование исходного кода: Архитектура связки Beyond Boundaries (BB), Provider-Pi, Upstream Pi и Durable-Zero

**Дата:** 2 ноября 2026 г.  
**Цель:** Провести глубокий анализ исходных кодов экосистемы (Beyond Boundaries, официальный `provider-pi`, upstream `pi`, суверенный `durable-zero` и `bb-plugin-provider-pi-durable`), вскрыть коренную причину антипаттерна «постоянного копирования файлов» и выстроить каноническую архитектуру Single Source of Truth (SSOT).

---

## 1. Анализ официального `provider-pi` в Beyond Boundaries

**Путь исходников:** `/Users/vanya/Projects/bb-reference/server/dist/builtin-plugins/provider-pi`

### 1.1. Роль и устройство официального плагина:
1. `package.json` плагина декларирует:
   ```json
   "experimental_providers": [
     { "kind": "agent", "id": "pi", "displayName": "Pi" }
   ],
   "server": "./dist/server.js",
   "host": "./dist/host.js",
   "app": "./dist/app.js"
   ```
2. **В плагине `provider-pi` НЕТ исходников движка Pi, раннера или инструментов!**
   Вся кодовая база плагина состоит исключительно из:
   - `server.ts` — регистрация провайдера в реестре BB.
   - `host.ts` (`src/host/`) — мост сессий (`PiThreadSession`), транслятор событий в дельты тредов (`threadDeltaSchema`), UI мост.
   - `app.tsx` — фронтенд-компоненты для сайдбара и настроек.

### 1.2. Как официальный `provider-pi` запускает рантайм:
В декомпилированном/исследованном коде `host.js` (функция `resolvePiLaunch` / `spawnPortableProcess`):
```ts
// provider-pi/dist/host.js
function resolvePiLaunch(env) {
    let cmd = env["BB_PI_BRIDGE_COMMAND"];
    if (!cmd) return { command: "pi", args: [] };
    // ...
}

this.child = spawnPortableProcess({
    command: r.command, // по умолчанию просто системный бинарник "pi"
    args: [...r.args, "--mode", "rpc", "--no-session", ...],
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] // 5 файловых дескрипторов!
});
```
**Ключевой вывод:** Официальный плагин BB **никогда не компилирует и не содержит внутри себя движок агента**. Он ожидает готовый внешний исполняемый процесс или библиотеку, говорящую по протоколу JSON-RPC через 5 файловых дескрипторов (FD 0..4).

---

## 2. Анализ Upstream Pi

**Путь исходников:** `/Users/vanya/Projects/pi`

Upstream Pi — это монорепозиторий пакетов:
- `@earendil-works/pi-agent-core` (`packages/agent`)
- `@earendil-works/pi-ai` (`packages/ai`)
- `@earendil-works/chord` (`packages/chord`)
- `@earendil-works/pi-coding-agent` (`packages/coding-agent`)
- `@earendil-works/pi-durable` (`packages/durable`) — ACID SQLite рантайм, таск-граф, вотчеры.
- `@earendil-works/pi-schema` (`packages/schema`) — новая валидация схем инструментов (в Pi 1.5.0).
- `@earendil-works/pi-codemode` (`packages/codemode`) — изоляция QuickJS Wasm.

В `packages/coding-agent/src/cli/args.ts` и `src/modes/rpc/` реализован нативный RPC-режим:
`pi --mode rpc` читает JSONL-команды из `stdin`, пишет события в `stdout`, а также использует FD 3/4 для двустороннего bridge-канала (запросы `model-scope`, кастомные инструменты).

---

## 3. Анализ `durable-zero`

**Путь исходников:** `/Users/vanya/Projects/durable-zero`

`durable-zero` был спроектирован как **суверенное открытое ядро (MIT)**:
- `packages/contracts` (`@durable-zero/contracts`) — единый источник правды (SSOT) для DTO и протокола (команды, события, схемы `runner-channel`, `runner-event`, `runner-command`).
- `packages/core` (`@durable-zero/core`) — реализация ACID SQLite движка (`DurableEngine`), демона сессий `SessionDaemon`, `SchemaPort`, `ViewStreamProjector`, `WatcherCompat` и `runner-server.ts`.
- `packages/sdk` (`@durable-zero/sdk`) — интерфейсы расширений и плагинов.
- `packages/plugins` (`@durable-zero/plugins`) — встроенные плагины (coding-tools, codemode, subagents).
- `packages/cli` (`@durable-zero/cli`) — автономный CLI `bin/durable-zero.js`.

---

## 4. Коренная причина антипаттерна «постоянного копирования» (Root Cause)

### Что пошло не так:
1. Изначально раннер и контракты разрабатывались внутри `bb-plugin-provider-pi-durable/src/runner/` и `src/contracts/`.
2. В Cycle 103 `durable-zero` был выделен в отдельный репозиторий путём копирования этих файлов.
3. **Но плагин `bb-plugin-provider-pi-durable` НЕ был переключен на потребление `durable-zero`!**
   Внутри плагина остались те же самые 56 файлов в `src/runner/` и 12 файлов в `src/contracts/`.
4. В результате:
   - Скрипт сборки плагина `scripts/build-runner.mjs` продолжал компилировать `src/runner/index.ts` из своего локального каталога.
   - Любое исправление (например, поддержка Pi 1.5, `watchEvents`, `SchemaPort`, `control-channel`) вносилось локально в плагин, а затем вручную «пробрасывалось» через `cp` в `durable-zero`.
   - Это привело к двум рассинхронизированным источникам правды, дублированию кода и бесконечному ручному труду.

---

## 5. Каноническая целевая архитектура (Target Architecture)

```
┌────────────────────────────────────────────────────────────────────────┐
│                   durable-zero (ЕДИНСТВЕННЫЙ ИСТОЧНИК ПРАВДЫ)          │
│                                                                        │
│   • packages/contracts: канонические DTO протокола и FSM               │
│   • packages/core: всё ядро Durable, порты Pi 1.5, runner-server.ts   │
│   • scripts/build.mjs: собирает dist/index.js и dist/runner.js         │
│   • Публикуется на GitHub как суверенная библиотека и рантайм          │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    │ npm install (git+https://...#v0.6.0)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│             bb-plugin-provider-pi-durable (ТОЛЬКО ХОСТ-АДАПТЕР)        │
│                                                                        │
│   • server.ts: регистрация в BB                                        │
│   • src/host/: мост BB тредов, транслятор в threadDeltaSchema          │
│   • app.tsx: React-компоненты десктопа BB                              │
│   • scripts/build-runner.mjs: разворачивает runner.js из durable-zero  │
│   • 0 дубликатов исходников runner/ в дереве плагина!                  │
└────────────────────────────────────────────────────────────────────────┘
```

### Принципы рефакторинга:
1. **Никакого `cp`:** Исходники раннера и контрактов живут строго в `durable-zero`.
2. **Хост только импортирует:** `bb-plugin-provider-pi-durable/src/host/` импортирует контракты и типы напрямую из пакета `durable-zero/contracts`.
3. **Раннер собирается в ядре:** `durable-zero` сам собирает готовый бинарник раннера (`runner.js` + `quickjs.wasm`), а `bb-plugin` при установке/сборке использует его напрямую.
