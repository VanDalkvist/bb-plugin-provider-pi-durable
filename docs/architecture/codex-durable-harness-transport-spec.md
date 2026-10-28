# Pi Durable Harness: transport seam and external-adapter architecture

**Статус:** Architecture proposal / исследовательский отчет (не реализация и не утверждение кода).  
**Срез исходников проекта:** `main`, локальный checkout при исследовании; `@earendil-works/pi-durable` закреплен в plugin `1.4.0`.  
**Цель:** Переиспользовать транзакционный runtime в других приложениях, не превращая `bb-plugin-provider-pi-durable` в socket daemon, сервер или PTY-слой.

## Краткий вывод

Правильная граница — не «добавить сокеты в runner», а дать runner/application явную **in-process границу доставки** и вынести server/listener/client protocol, socket, auth и daemon lifecycle в отдельный репозиторий Андрея. В plugin остаются текущая реализация stdio и совместимость BB; сетевой adapter не попадает в зависимости или сборку provider.

Есть важная оговорка: существующий `src/runner/index.ts` — это не только чистый Pi Durable harness. Он одновременно собирает runtime, BB-specific команды/события и FD3/FD4 side channel. В `runtime.ts` есть `openDurable()`, но оно опирается на `selectSession`, Pi model setup, расширения и собственную внутреннюю композицию. Поэтому просто экспортировать `openDurable()` как стабильный reusable SDK или подменить stdin/stdout интерфейсом — недостаточно и создало бы ложное обещание переносимости. Рекомендуемый seam — минимальный `RunnerTransport` в runner-приложении плюс фабрика, отделяющая создание/обслуживание runner runtime от stdio entrypoint; независимый server принимает на себя сетевой протокол и сессии. Не добавлять Unix/TCP/WebSocket/PTY реализации сюда.

**Экосистема уже развивается в этом направлении:** Pi Pocket — полноценное, но отдельное multi-user веб-приложение на Pi Durable; upstream `earendil-works/pi` теперь содержит экспериментальные `pi-server`/`pi-client` с transport/listener seam и Unix транспортом. Это materially меняет решение: перед созданием нового сетевого протокола Андрею следует проверить текущую версию `@earendil-works/pi-server` и решить, подходит ли она. Ни один из этих проектов не является готовым доказательством, что текущий BB runner можно подключить напрямую без адаптации.

## 1. Границы ответственности: Four Territories / Thin Bridge

```text
┌──────────────────────────────────────────────────────────────┐
│ T1 — Клиенты / интерфейсы                                    │
│ BB IDE, терминальный клиент, web/PWA, CLI scripts             │
└───────────────────┬──────────────────────────────────────────┘
                    │ внешний протокол/DTO (при необходимости)
┌───────────────────▼──────────────────────────────────────────┐
│ T4 — Adapters и composition roots                             │
│ plugin src/host (BB SDK)       Андрей: отдельный server repo   │
│ provider bridge, process mgmt  HTTP/socket/auth/CLI/lifecycle │
│ stdio process adapter          server protocol/client adapter │
└───────────────────┬──────────────────────────────────────────┘
                    │ внутрипроцессный API / явные порты
┌───────────────────▼──────────────────────────────────────────┐
│ T3 — Pi ecosystem                                               │
│ pi-ai, coding-agent, модели, tools, MCP, extensions, skills   │
└───────────────────┬──────────────────────────────────────────┘
                    │ Harness API
┌───────────────────▼──────────────────────────────────────────┐
│ T2 — Pi Durable core + storage                                │
│ Harness/Session, FSM/tasks, commits, SQLite/Chord             │
└──────────────────────────────────────────────────────────────┘
```

- **T2 (engine):** `@earendil-works/pi-durable` владеет atomic commit semantics, session/task scheduler, durable records и storage API. Его документация прямо говорит: все изменения идут через одну линию atomic commits; открытый Harness объединяет storage и machinery; persistence/backends — adapter responsibility.
- **T3 (ecosystem):** модели, tools, skills, extensions и environment устанавливает composition root. Это host policy, не транспорт.
- **T4 (adapters):** BB `src/host` реализует BB Provider SDK и делегирует жизненный цикл; runner sidecar говорит с ним текущим JSONL protocol плюс FD3/FD4. Андрейский отдельный adapter владеет своим listener, сессиями, auth, CLI и wire DTO.
- **T1 (surfaces):** UI/terminal/web — потребители протокола, не владельцы SQLite и не владельцы FSM.

**Thin Bridge invariant:** BB plugin переводит BB provider contract в runner commands/events, маппит события назад и координирует process/session lifecycle. Он не должен становиться универсальным web server, не владеть внешней идентификацией пользователей, сетевым API или транспортными реализациями. Не привносить чужой TUI/PTY ради повторного использования.

## 2. Runner seam: проектируемый контракт

### 2.1 Что transport означает здесь

Существующий runner использует две независимые линии:

1. Основная JSONL линия: commands на stdin, responses/events на stdout (`src/runner/index.ts`, `jsonl.ts`).
2. BB side channel: FD3 из runner и FD4 в runner (`bridge-channel.ts`), включая model-scope и запросы bridge.

Не надо притворяться, что это один двусторонний `stdin/stdout` интерфейс. Для абстракции лучше определить логическую пару каналов внутри runner: `commands` (read) и `outbound` (write); BB-only side channel оставить BB extension портом и не включать в transport contract первого этапа. Если server-runtime требует model scope/refresh semantics, это отдельный application capability, который внешний host предоставляет явным портом, а не скрытая транспортная магия.

```ts
// Предлагаемые имена; ниже — design sketch, не текущие exports.
export interface RunnerTransport {
  /** Последовательность уже собранных JSONL records; один record = одна команда. */
  readonly inbound: AsyncIterable<string>;
  /** Доставка JSON value наружу. Реализация обязана сериализовать/фреймировать согласно wire contract. */
  send(message: RunnerOutbound): Promise<void>;
  /** Отмена чтения/записи. Отключение транспорта НЕ означает abort durable work. */
  close(reason?: Error): Promise<void>;
}

// Не экспортировать BB DTO как reusable API. Это внутренний sketch для адаптера.
export type RunnerOutbound =
  | { kind: "ready"; ready: true }
  | { type: "response"; id?: string; command: string; success: true; data?: unknown }
  | { type: "response"; id?: string; command: string; success: false; error: string }
  | { kind: "application-event"; name: string; payload: unknown };

export interface RunnerApplicationOptions {
  transport: RunnerTransport;
  runtimeOptions: OpenDurableOptions;
  /** Внутренняя BB composition seam, не часть external public API. */
  bridge?: RunnerBridgePort;
}

export interface RunnerApplication {
  run(signal?: AbortSignal): Promise<void>;
  close(reason?: string): Promise<void>;
}

export function createRunnerApplication(options: RunnerApplicationOptions): RunnerApplication;
```

**Ключевые свойства:** API возвращает lifecycle handle; transport не знает о Harness, SQLite или BB SDK. `createRunnerApplication`/factory — composition root для runtime, command dispatcher и event adapter. `StdioTransport` остаётся единственной встроенной поставкой; он подключает `process.stdin`, `writeWireStdout` и существующий stdout guard. Factory не должна экспортировать raw DB handle или разрешать произвольный второй writer.

**Public API caveat:** Даже эта transport abstraction сама по себе не делает plugin reusable: текущие commands и event types — BB-shaped (`RunnerCommandPayload`, `BBWireEvent`), а `openDurable` не является нейтральным runtime factory. Поэтому не экспортировать этот sketch как SDK, пока не определена отдельная transport-neutral application API (use-cases + DTO) или пока server не реализует совместимость с BB runner protocol сознательно. Не выдавать `BBWireEvent` через якобы универсальный порт.

Вариант еще более узкой границы — generic `RunnerChannels` (AsyncIterable input + async output) и полностью транспортный JSONL framing сверху. Не делать transport интерфейс со всеми `listen/connect/broadcast/clientAttached` методами: такой контракт уже фактически описывает сервер, а не порт runner. `mode: "stdio" | "socket"` также нежелателен в core — runner не должен знать транспортные бренды.

### 2.2 Точки изменения и текущий код

| Область | Предложенное изменение | Почему / ограничение |
|---|---|---|
| `src/runner/index.ts` | Сохранить CLI entrypoint и `--version`; заменить чтение process.stdin/`output()` на созданный `StdioTransport` + `createRunnerApplication`. Перенести runner lifecycle/dispatch в модуль(и) с <200 строк на файл. | Текущий файл 195 строк. Он смешивает загрузку моделей, open runtime, lifecycle, event wiring, catalog mode и command parsing. Наиболее безопасно оставить index тонким composition root. |
| `src/runner/jsonl.ts` | Оставить serializer; выделить ограниченный JSONL reader/stream adapter contract, если он нужен. Добавить предельный размер строки только как отдельное, согласованное изменение protocol. | Сейчас reader принимает Readable и обрабатывает LF/UTF-8, но не ограничивает размер фрейма. Это не повод вводить 16 MiB произвольно. |
| `src/runner/stdout-guard.ts` | Не менять семантику; `StdioTransport` должен отправлять protocol output через `writeWireStdout()` и `flushWireStdout()`. | Upstream `pi-coding-agent` stdout takeover важен для чистоты wire. Утечка stdout ломает JSONL protocol. |
| `src/runner/bridge-channel.ts` | Оставить как BB-specific channel. Только при появлении подтвержденного external-host use case выделять `RunnerBridgePort` отдельно. | Сейчас используется socket на FD3/4, model-scope. Нельзя потерять эти возможности при переключении stdout. |
| `src/runner/session-commands.ts`, `contracts/runner-command.ts`, `bridge/*` | Сохранить DTO и поведение. Factory вызывает существующий dispatcher/adapters; изменения протокола требуют contract tests. | Это runner application contract, но часть DTO и событий BB-shaped; reusable SDK должен четко описать, где заканчивается BB wire. |
| `src/runner/runtime.ts`, `runtime-loader.ts`, `harness-setup.ts` | Не объявлять `openDurable()` public portable SDK без разделения runtime core и BB/Pi host setup. Выделение — отдельная архитектурная работа и отдельный публичный API. | `openDurable()` сейчас одновременно выбирает session dir, получает модели/settings/extensions, создает view/controller и lifecycle cleanup. |
| `src/host/*` | **В scope транспорта runner — изменений не требуется.** Host по-прежнему запускает runner через `RunnerProcess`, взаимодействие остается stdio + FD3/4. | `RunnerProcess` — BB host process adapter, не transport plug-in для удаленного runner. Не добавлять socket auto-discovery или daemon attachment. |

### 2.3 Factory/wiring sketch

```ts
// runner/index.ts — sketch
const transport = new StdioTransport({
  input: process.stdin,
  write: (jsonl) => writeWireStdout(jsonl),
  onProtocolError: reportTransportFault,
});
await setupRunnerStdoutGuard();
const app = createRunnerApplication({
  transport,
  runtimeOptions: optionsFromCli(args),
  bridge: createBbBridgePort(), // только legacy BB launch
});
await app.run();
```

```ts
// createRunnerApplication — sketch of composition, not a separate socket server
export function createRunnerApplication(options: RunnerApplicationOptions): RunnerApplication {
  return {
    async run(signal) {
      const runtime = await openDurable(options.runtimeOptions);
      try {
        await installRuntimeEventPublishers(runtime, options.transport);
        await dispatchUntilClosed(runtime, options.transport.inbound, signal);
      } finally {
        await runtime.close();
        await options.transport.close();
      }
    },
    async close() { /* idempotent graceful application cleanup */ },
  };
}
```

В реальном коде «disconnect => runtime.close» нельзя автоматически принять как целевую семантику для daemon (close harness прекращает worker и может остановить активные задачи). Внешний сервер контролирует свою политику detach/reconnect и срок жизни runtime; runner API должен различать shutdown от detach. При этом API не должен создавать socket, хранить clients, делать fanout или отвечать за reconnect.

**Надёжная последовательность внедрения:** сначала транспортный контракт сохраняет прежнюю семантику stdio один-в-один; затем контрактные тесты на wire parity; только отдельным release runner application factory экспортируется как документированная package entrypoint. До такого export Андрей не должен зависеть от `src/` файлов или копировать `dist/runner/index.js` как «библиотеку».

### 2.4 AP-019: размеры файлов

Локальный AGENTS проекта говорит: все TS в runner строго <200 строк, host <250 строк. Это локальный более строгий бюджет, чем общий AP-019 (soft 150/hard 250). Текущее: `src/runner/index.ts` — 195 строк; `src/host/runner-process.ts` — 181, `session.ts` — 199, `session-registry.ts` — 198. Добавлять interface в монолитный index нельзя. Новые модули дробить по одному понятию (transport contract, stdio adapter, app factory/dispatch) и проверить `wc -l`; существующий host не рефакторить ради абстракции, которая ему не нужна.

## 3. База, concurrency и безопасная модель

### 3.1 Single Storage Owner — инвариант, не «SQLite умеет WAL»

Pi Durable README называет SQLite WAL, `synchronous=NORMAL`: commit сохраняется при process crash, но последний commit может пропасть при потере питания/хоста. В README также прямо сказано: **one process owns a storage at a time; there is no cross-process locking**. WAL не делает два независимо открытых `Harness` безопасными писателями и не заменяет ownership protocol.

```text
terminal / BB / web clients
      │ requests only
      ▼
external server (session registry + access control)
      │ in-process owner API
      ▼
one Harness instance per storage/session owner
      │ one Pi Durable storage handle
      ▼
SQLite WAL: one writer process
```

Требования к внешнему server adapter:

- Серверный процесс (или выделенный worker с явной границей) — единственный владелец открытого writable storage/Harness на сессию.
- Клиенты отправляют команды только через server API; им не выдаются sqlite path/connection и не разрешается открывать writable `openNodeSqliteStorage()` напрямую.
- Любой второй owner должен быть отвергнут/координирован на уровне приложения; проверенный session lock в plugin — полезная страховка для текущего режима, но не API для multi-process DB sharing.
- SQLite WAL допускает читателей при writer, но не дает права прямого concurrent SQL reads/writes по прикладной схеме без согласованной политики. Холодный read endpoint — отдельное решение с read-only connection, стабильной схемой/миграциями и доказанным поведением; для первой версии использовать RPC snapshot.
- Для нескольких пользователей нужны authentication + authorization на каждом command (session-level access, роль view/steer/driver); local socket permissions — не auth для TCP/WebSocket. Выдача steer доступа равна возможности выполнять tools от имени процесса пользователя.
- Idempotency ключ на повторяемую submit/command; bounded queues/frame sizes, timeout/backpressure, disconnect cleanup и typed errors. Durable idempotency полезна, но транспортный request ID должен быть связно сопоставлен с Durable submission requestId.
- Сессионные migrations выполнять при старте owner-процесса; не позволять двум версиям writer одновременно мигрировать/open одной DB. Версия `pi-durable` experimental, schema migrations могут быть необратимы.

### 3.2 Disconnect ≠ abort

Транспортное закрытие само по себе не должно означать interrupt durable task. Различать как минимум:

- `detach`: отключить client presentation, разрешить server-owned task продолжать/быть восстановленным по продуктовой политике.
- `interrupt`: отдельная авторизованная команда, вызывает соответствующий Durable abort semantics.
- `shutdown`: owner process закрывает Harness штатно, завершает subscriptions/resources, освобождает lock и storage.

Это не дает разрешения делать daemon бессмертным: server отвечает за idle policy, crash recovery, OS signals, supervisor и понятное подтверждение остановки.

## 4. Сервер Андрея: территория отдельного репозитория

### 4.1 Правильная структура

```text
pi-durable-server/              # отдельный проект, независимый BB plugin
  src/
    app/                         # session management, policy, command use-cases
    protocol/                    # versioned DTO, validation, errors
    transport/                   # owned adapters: HTTP/WS/UDS/CLI as chosen
    storage/                     # session catalog metadata; not shadow writes to Harness DB
    runtime/                     # adapter to published harness API or upstream Pi Server
    cli/                         # start, status, sessions, attach, stop
    composition-root.ts
  test/
    protocol-contract/
    transport-conformance/
    runtime-integration/
```

Не копировать provider, не vendoring `src/host`, не патчить BB Core. Pin compatible `@earendil-works/pi-durable`/plugin version and use a documented package export. Пока plugin не предоставляет stable runtime-factory API, server should integrate `@earendil-works/pi-durable` itself (plus its own coding-agent setup) or target upstream server package, rather than importing private source paths.

### 4.2 Adapter sequence

1. `SessionDirectory` хранит каталог сессий (id, cwd, labels, owner/access policy, durable storage locator) вне транспорта.
2. `RuntimeFactory.acquire(id, mode)` единолично берет lease для session и возвращает application capability с prompt/steer/abort/snapshot/subscribe/dispose.
3. Server composition root создает `RuntimeFactory` и `SessionManagement`; listener/transport слой принимает соединения и проводит auth до передачи командам.
4. Для нескольких клиентов сервер проецирует committed snapshots/events. Стримятся только committed facts; reconnect получает полный snapshot или последовательные revisions/event cursor.
5. Локальный terminal CLI — еще один client. Его можно сделать в том же отдельном репозитории; CLI для демона не означает PTY вокруг модели.

Пример интеграции с upstream API (концептуальный; точные types брать из pinned release):

```ts
const runtimeFactory = new DurableRuntimeFactory({
  storageFor: (id) => openNodeSqliteStorage(sessionPath(id)),
  models,
  registry,
});
const server = new PiServer({
  sessions: sessionManagement(runtimeFactory),
  listeners: [transportListener], // unix/http/ws implementation owned/selected here
  authorize: policy.authorize,
});
await server.start();
```

Не использовать одновременно server-protocol object, собственный JSON-RPC и RPC BB host внутри одной и той же роли. Выберите один внешний API contract, версионируйте его независимо от внутреннего runner protocol.

## 5. UX: терминал и BB сосуществование

### 5.1 Пользователь работает вне BB

Сценарий с отдельной server distribution:

```sh
npm install -g @andrey/pi-durable-server   # пример имени, не существующий пакет
pi-durable-server start --cwd ~/work/app
pi-durable sessions
pi-durable attach <session-id>              # line-oriented terminal client, не pseudo-terminal
pi-durable prompt <session-id> "Проверь тесты" --request-id task-42
pi-durable status <session-id>
```

Форма команд — продуктовый выбор Андрея, не изменение plugin. Если нужен полноценный терминальный UI, это отдельный клиент; не загонять JSON protocol через PTY. Для long-running tasks `start` запускается под launchd/systemd/контролируемым supervisor; CLI attach можно закрыть не отменяя задачу, если серверная политика допускает detach.

### 5.2 BB IDE подключается/сосуществует

- В исходно предлагаемом scope BB остаётся текущим standalone stdio plugin. Он и server instance не должны одновременно открывать одну и ту же session DB writable.
- Для просмотра server-сессии в BB требуется официальный BB Provider adapter/API, который умеет подключаться к server client contract, либо пользователь открывает отдельный BB integration plugin. Это живет в новом adapter/repo, не в provider core.
- Если нужно вести одну сессию и в BB, и в CLI, оба клиента подключаются к server owner через read/steer capability с авторизацией; не запускаются два provider runner на одном sqlite-файле.
- Если такого external adapter для BB пока нет, BB может отдельно создать свою Pi Durable сессию. Синхронизация двух Harness баз не возникает автоматически; fork/export/import — отдельный продуктовый контракт.
- Режимы не следует autodetect-ить по socket files в `src/host`: он добавляет скрытую precedence/fallback и усложняет восстановление. Явное управление принадлежит внешнему adapter.

## 6. Экосистема и первоисточники

Дата проверки текущих доступных страниц и локального checkout: 28 октября 2026. Upstream Durable README предупреждает, что API experimental и может изменяться без уведомления.

### 6.1 Pi Pocket (TannerMidd/pi-pocket)

Pi Pocket уже демонстрирует полноценное приложение на Pi Durable: один Node.js server, одна SQLite DB, web clients на JSON API и SSE/long-polling; Durable commits передаются открытым вкладкам после commit. Присутствуют пользователи/roles/invites, presence, side chat, reattach/recovery и session management. Важное ограничение прямо указано: **only one server process can use the database at a time**. Это single-process owner + multi-client access, не многопроцессные DB writers.

Применимые паттерны:

- один composition root (`PocketApp`) создает Harness и зависимости; parts получают narrow host capabilities;
- persistent truth в Durable docs, derived in-memory state восстанавливается на startup; единый commit coordinator вместо взаимозависимых listeners;
- role/access check и turn-taking перед command; submit idempotency; snapshots при reattach;
- live state (presence/typing/approvals) отделяется от долговременных Durable records;
- server/runtime API делегирует записи Harness, а не пишет таблицы параллельно.

Грабли/непереносимые решения: Pi Pocket — крупный самостоятельный продукт и его встроенный server вовсе не означает, что его надо копировать в BB provider. Мультипользовательский доступ требует серьезного auth/policy model. Не считать network security равной socket file permission; не делить SQLite writer; worktree не равен sandbox. Технические детали Pocket не являются обещанным API для других проектов.

### 6.2 Upstream `earendil-works/pi` server/client

В upstream monorepo текущие `packages/server` и `packages/client` предлагают более низкоуровневое разделение:

- `PiServer` композирует `PiServerListener[]`; транспортные listener-ы подключаются отдельно, auth выполняется до передачи connection серверу.
- `PiServerService`/runtime interface задают прикладную границу list/create/open sessions; это не готовый standalone CLI/app — приложение поставляет service.
- `@earendil-works/pi-client` имеет transport-neutral `ByteTransportFactory`, ordered send/backpressure, reconnection по явному вызову; один client может attach multiple sessions, session leases различают shared/exclusive ownership.
- В другой/экспериментальной ветке API `RoutedSessionHandle` и `attachmentId` отделяют presentation attachment от Harness worker ownership; сервер не передает открытый JS Harness за process boundary. Ветка и версии менялись — сверять pinned commit/package release до использования.
- Есть Unix transport subpath и conformance test support; это именно upstream отдельный пакет, а не код для переноса в наш plugin.

**Оценка:** приоритетно переиспользовать/оценить upstream `pi-server`/`pi-client`, если его зрелость/API подходят; иначе server-репозиторий Андрея может использовать те же принципы (transport-neutral core, injectable listener, protocol conformance, bounded ordered frames) — не копировать внутренние server types. API upstream отмечен experimental; auth/policy and deployment responsibilities remain application-owned.

### 6.3 Что показал локальный код

- `src/runner/index.ts` напрямую содержит process signal/stdin lifecycle и `attachJsonlLineReader(process.stdin, ...)`; output строит JSONL через `writeWireStdout`.
- `src/runner/bridge-channel.ts` использует отдельные FD3/FD4 для BB channel; переносить на общий transport без parity tests нельзя.
- `src/host/runner-process.ts` запускает runner child с `stdio: [pipe,pipe,pipe,pipe,pipe]`, парсит stdout и FD3, пишет commands в stdin и принимает bridge channel FD4.
- `src/runner/runtime.ts` экспортирует внутренний `openDurable`, но одновременно собирает Pi settings/models/extensions/session location, runtime view/controller, subscriptions и cleanup. Само наличие export не равняется stable external SDK contract.
- `@earendil-works/pi-durable` 1.4.0 README — единственный владелец storage transaction contract; он прямо запрещает предположение о cross-process locking.

### 6.4 Первичные ссылки

1. Pi Durable README/storage concepts: https://github.com/earendil-works/pi/blob/main/packages/durable/README.md (особенно Concepts, Persist and Resume, Storage). Локальная копия: `~/Projects/pi/packages/durable/README.md`.
2. Pi Durable package source: https://github.com/earendil-works/pi/tree/main/packages/durable/src — локальный upstream checkout `~/Projects/pi/packages/durable/src`.
3. Pi Pocket official repo: https://github.com/TannerMidd/pi-pocket
4. Pi Pocket architecture: https://tannermidd.github.io/pi-pocket/docs/architecture/
5. Pi Pocket engineering: https://tannermidd.github.io/pi-pocket/engineering.html
6. Pi server source/readme: https://github.com/earendil-works/pi/tree/main/packages/server and https://github.com/earendil-works/pi/blob/main/packages/server/README.md
7. Pi client source/readme: https://github.com/earendil-works/pi/blob/main/packages/client/README.md
8. Pi server typed service/listener API: https://github.com/earendil-works/pi/blob/main/packages/server/src/types.ts and `src/listener.ts`.
9. Experimental server implementation PR: https://github.com/earendil-works/pi/pull/7386 (composable server core; inspect merged state and current main before relying).
10. Pi Durable 1.4 package declaration in this plugin: `package.json` and `package-lock.json`; plugin code paths cited above.

## 7. Tests and verification evidence

The user-mentioned “308 tests” is not the current suite size in the inspected checkout. A fresh `npm test` completed successfully in this turn:

- contract test compile + negative contracts stage ran as part of `npm test`;
- Node suite: **556 passed, 0 failed**;
- UI suite: **83 passed, 0 failed**;
- combined reported assertions: **639 passed, 0 failed**.

This is a **baseline before any transport code change**, not proof that a future refactor is regression-free. Acceptance for a future implementation should compare whole-suite totals against the same checkout/baseline and add tests for (1) stdio command/response/event parity, (2) FD3/FD4 behavior, (3) no protocol stdout leakage, (4) close vs abort semantics, (5) bounded frame/backpressure behavior if changed, (6) cleanup of all runtime resources, (7) session single-owner lock. Contract tests should prove legacy BB launch stays byte-compatible. No claim that a non-BB server exists or can currently import a stable runner factory is made here.

## 8. Decision and recommendations to Андрей

1. Do not fork the BB plugin and do not patch BB Core. Keep his own server and CLI in a separate repository/package.
2. First evaluate upstream `@earendil-works/pi-server`/`pi-client`: the upstream already has server/listener/client transport interfaces and Unix transport implementation, whereas this provider has no server feature and does not need one.
3. If a provider-owned seam is still required, request a narrow, versioned `createRunnerApplication({ transport, runtimeOptions, bridge? })` export and `RunnerTransport` contract; it provides the same runtime *application* with IO substitution, not a generic network daemon.
4. Keep StdioTransport in the existing runner package as the default composition for BB. Do not add Unix server/listener dependencies, networking, PTY, auth server, daemon flags, socket discovery, multi-user sessions, or daemon lifecycle to this repository.
5. Put session catalog, external authz/authn, server process lifecycle, protocol versioning, client SDK, CLI, TCP/WebSocket/UDS, and operational packaging in Андрей’s repo. One server-owned writable Harness per DB/session.
6. Do not advertise current `openDurable` as a general supported public API until its BB/Pi-specific setup, config contract, lifecycle and compatibility promise are deliberately extracted and tested.

## Architecture verification (proposal-level)

- **Passed by design:** AP-010 Ports & Adapters; AP-011 low coupling; AP-016 authoritative access checks in external server; AP-019 current runner/host file budgets documented; AP-020 composition roots separate; AP-021 thin host/runner entrypoints; AP-026 explicit external DTO boundary; AP-028 transport contract/conformance tests prescribed; AP-033 atomic writes remain in Durable; AP-034 one process/storage owner explicitly required; AP-039/040 external identity and authorization owned by server.
- **Not claimed:** implementation of RunnerTransport, API publication, external server integration, cross-client BB attachment, or future regression-free refactor.
- **Residual risk:** runner runtime/application still includes BB-specific protocols and process/global assumptions; external reuse needs a supported public package seam and lifecycle design. Pi Server APIs and Durable APIs are experimental and version-sensitive. Multi-user network control expands local code-execution authority and needs threat modeling.

## Источники текущего проекта

`src/runner/index.ts` (195 lines), `src/runner/runtime.ts`, `src/runner/jsonl.ts`, `src/runner/bridge-channel.ts`, `src/runner/stdout-guard.ts`, `src/runner/session-commands.ts`, `src/host/runner-process.ts` (181), `src/host/session.ts` (199), `src/host/session-registry.ts` (198), `package.json`, local `AGENTS.md`. Предыдущий `docs/architecture/pi-durable-daemon-socket-transport-spec.md` содержит daemon/socket proposal, но значительная часть scope (socket server, dual mode, host attach, direct WAL reads) противоречит текущему требованию держать transport/server вне plugin и не должна считаться утвержденной спецификацией.
