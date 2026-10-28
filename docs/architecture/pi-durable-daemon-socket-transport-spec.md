# Техническая спецификация и архитектурный блюпринт: Декомпозиция Pi Durable

## Автономный Server Daemon и Двухрежимный Транспорт (Stdio / Unix Domain Socket) для Beyond Boundaries IDE

**Документ:** Архитектурная спецификация (Technical Specification & Architecture Blueprint)  
**Статус:** Proposal / Ready for Architecture Review (RFC)  
**Версия:** 1.0.0  
**Дата:** 28 октября 2026 г.  
**Автор:** Principal System Architect  
**Проект:** `bb-plugin-provider-pi-durable`  
**Связанные стандарты:** The Four Territories & Thin Bridge Invariant, AP-010 – AP-071, ACID SQLite WAL Persistence  

---

## 1. Контекст, архитектурный аудит и постановка проблемы

### 1.1. Текущее состояние (Embedded Mode)
В текущей реализации плагин `bb-plugin-provider-pi-durable` функционирует исключительно в режиме жесткой связанности процесса (Embedded Mode):
1. Хост-воркер Beyond Boundaries IDE (`src/host/index.ts`) через класс `RunnerProcess` (`src/host/runner-process.ts`) порождает изолированный дочерний Node.js процесс раннера (`src/runner/index.ts`) с конфигурацией межпроцессного взаимодействия через дескрипторы ввода-вывода `stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"]` (FD 0–4).
2. Запущенный раннер захватывает эксклюзивную файловую блокировку через `proper-lockfile` на директорию сессии (`~/.pi/agent/experimental/durable-sessions/<hash>/<session-id>/`) и единолично открывает базу данных `session.sqlite` через `@earendil-works/pi-durable`.
3. Любое штатное или нештатное закрытие вкладки, перезагрузка окна Beyond Boundaries (`Cmd+R`), обновление плагина или рестарт хост-воркера посылает дочернему процессу сигналы `SIGTERM`/`SIGKILL` либо закрывает дескриптор `stdin.end`.
4. В результате раннер аварийно или принудительно останавливается, обрывая исполняющиеся фоновые задачи агента: генерацию больших языковых моделей, многошаговые вызовы инструментов, компиляцию кода, выполнение тестовых наборов и автономную координацию сабагентов (`Reporter`/`Courier`).
5. Архитектурно невозможно подключить Beyond Boundaries IDE к сессии Pi Durable, уже запущенной локально в терминале, работающей в фоновом системном сервисе (например, под управлением `systemd`, `launchd` или `pm2`) либо развернутой на удаленной headless-машине.

### 1.2. Анализ попытки решения коллеги (`pi-durable-bb-adapter`)
Попытка коллеги (Андрей / Diffuzmetall) решить данную проблему в лоб через отдельный адаптер `pi-durable-bb-adapter` выявила ряд критических архитектурных антипаттернов:
- **Вторжение в ядро хоста (Core Invasion):** Попытка форсировать архитектуру через 24 МБ кастомных бинарных оверлеев и патчей ядра Beyond Boundaries Core вместо использования официально декларированных точек расширения плагинного SDK (`@get-bb/plugin-sdk/provider-bridge`).
- **Смешение транспортных уровней через псевдотерминалы (PTY Coupling):** Использование Python-скриптов и эмуляции псевдотерминала (`pty.fork()`) для перехвата стандартных потоков. Это привело к race-conditions при передаче бинарных чанков, порче JSON-RPC фреймов символами управления ANSI, потере структурированных метаданных и утечкам файловых дескрипторов.
- **Платформенная зависимость (POSIX/Linux Lock-in):** Архитектура оказалась жестко привязана к специфичным системным вызовам ядра Linux (ioctl TIOCGWINSZ, семантика сигналов Linux), полностью сломав работу на macOS (Darwin) и сделав невозможной переносимость на Windows.
- **Нарушение инварианта Four Territories:** Стирание границ между UI-шеллом, Harness ядра Durable и состоянием хранения.

### 1.3. Принципы целевой архитектуры
Целевое решение строится на фундаментальных архитектурных шаблонах:
- **Ports & Adapters (Hexagonal Architecture, AP-010):** Изоляция ядра раннера от деталей ввода-вывода. Внутри раннера обработка команд и трансляция событий не знают, откуда пришел байтовый поток — из `process.stdin` или из Unix Domain Socket.
- **The Four Territories & Thin Bridge:**
  - *Территория 1 (BB Host):* Оркестрация протокола провайдера Beyond Boundaries, отрисовка UI, сопоставление тредов.
  - *Территория 2 (Pi Durable Core):* Транзакционный FSM-движок задач, ACID SQLite, Chord LiveDoc.
  - *Территория 3 (Pi Ecosystem):* Модели, инструменты, MCP-серверы, навыки.
  - *Территория 4 (Provider Plugin & Runner Bridge):* Двунаправленный бесконфликтный адаптер протоколов.
- **Dual-Mode Transport:**
  - *Embedded Mode (по умолчанию, Zero-Config):* Сохранение текущей проверенной модели запуска дочернего процесса для рядовых пользователей IDE без накладных расходов на конфигурирование.
  - *Attached Mode (Socket / Standalone Daemon):* Подключение хоста Beyond Boundaries через локальный сокет Unix к долгоживущему независимому демону сессии.
- **Single Storage Owner (AP-034):** База данных `session.sqlite` имеет ровно одного пишущего владельца — процесс Server Daemon.

---

## 2. Архитектура уровней и компонентная схема

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           BEYOND BOUNDARIES IDE (HOST)                          │
├─────────────────────────────────────────────────────────────────────────────────┤
│ [ProviderBridge] (src/host/bridge.ts)                                           │
│        │                                                                        │
│ [SessionRegistry] (src/host/session-registry.ts)                                │
│        │                                                                        │
│ [PiThreadSession] (src/host/session.ts)                                         │
│        │                                                                        │
│        ▼                                                                        │
│ [IRunnerConnection] ◄──────────────────────────────────────────────────┐        │
│   ▲              ▲                                                     │        │
│   │ (embedded)   │ (attached)                                          │        │
│ ┌─┴────────────┐ ┌─┴──────────────────────────────┐                    │        │
│ │RunnerProcess │ │RunnerSocketConnection          │                    │        │
│ │(child_process│ │(node:net Client Socket)        │                    │        │
│ └──────┬───────┘ └──────────────┬─────────────────┘                    │        │
└────────┼────────────────────────┼──────────────────────────────────────┼────────┘
         │ Stdio Pipes            │ Unix Domain Socket                   │ Cold Read
         │ (FD 0,1,3,4)           │ (~/.pi/agent/run/.../daemon.sock)    │ (Read-Only)
         │                        │                                      │
┌────────▼────────────────────────▼──────────────────────────────────────┼────────┐
│                        PI DURABLE RUNNER / DAEMON                      │        │
├────────────────────────────────────────────────────────────────────────┼────────┤
│ [ITransport] (src/runner/transport/types.ts)                           │        │
│   ▲              ▲                                                     │        │
│ ┌─┴────────────┐ ┌─┴──────────────────────────────┐                    │        │
│ │StdioTransport│ │UnixSocketTransport             │                    │        │
│ └──────────────┘ └────────────────────────────────┘                    │        │
│        │                                                               │        │
│ [FrameCodec] (16 MiB Limit, \n Delimiter, Backpressure Drain)          │        │
│        │                                                               │        │
│ [RunnerRpcDispatcher] (Session Commands, Reattach Handshake)           │        │
│        │                                                               │        │
│ [OpenDurableResult] (Harness, Task FSM, Chord LiveDoc)                 │        │
│        │                                                               │        │
│ [SessionStorage] (proper-lockfile Single Owner, session.owner.json)    │        │
│        │                                                               │        │
│        ▼                                                               ▼        │
│ ┌─────────────────────────────────────────────────────────────────────────────┐ │
│ │                         SQLite Database (WAL Mode)                          │ │
│ │                  ~/.pi/agent/experimental/durable-sessions/...              │ │
│ └─────────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Абстракция транспорта в Runner (`ITransport`)

### 3.1. Архитектурный контракт интерфейсов
Входной точкой ввода-вывода для раннера становится абстракция порта `ITransport`. Ни один модуль доменной логики сессии (`handleActiveSessionCommand`, `BBEventAdapter`, `RuntimeGraphSource`) не имеет права напрямую обращаться к глобальным `process.stdin` или `process.stdout`.

```typescript
// src/runner/transport/types.ts

export type TransportState = "idle" | "listening" | "connected" | "closing" | "closed";

export interface TransportFrame {
  readonly payload: Buffer | string;
  readonly byteLength: number;
}

export interface TransportSessionEvents {
  frame: (frame: TransportFrame) => void;
  error: (error: Error) => void;
  close: (reason: string) => void;
  drain: () => void;
}

export interface TransportSession {
  readonly id: string;
  readonly remoteUid?: number;
  readonly remotePid?: number;
  readonly isAttached: boolean;
  send(data: string | Buffer): Promise<void>;
  close(reason?: string): Promise<void>;
  on<K extends keyof TransportSessionEvents>(event: K, listener: TransportSessionEvents[K]): this;
  off<K extends keyof TransportSessionEvents>(event: K, listener: TransportSessionEvents[K]): this;
}

export interface ITransportEvents {
  clientAttached: (session: TransportSession) => void;
  clientDetached: (session: TransportSession, reason: string) => void;
  error: (error: Error) => void;
  listening: () => void;
  close: () => void;
}

export interface ITransport {
  readonly mode: "stdio" | "unix-socket";
  readonly state: TransportState;
  readonly activeSession: TransportSession | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  broadcastEvent(eventPayload: string | Buffer): Promise<void>;
  on<K extends keyof ITransportEvents>(event: K, listener: ITransportEvents[K]): this;
  off<K extends keyof ITransportEvents>(event: K, listener: ITransportEvents[K]): this;
}
```

### 3.2. Фрейминг, буферизация и защита от переполнения
Все фреймы wire-протокола Pi Durable передаются в виде сериализованных JSON-строк с терминатором перевода строки `\n` (newline-delimited JSON, NDJSON).

#### Защита от переполнения буфера (16 МиБ Hard Limit):
1. **Константа максимального размера фрейма:**
   ```typescript
   export const MAX_FRAME_BYTES = 16 * 1024 * 1024; // 16 MiB (AP-045)
   ```
2. **Алгоритм накопления чанков:** Чанки буфера декодируются через `StringDecoder("utf8")`. Неполные строки накапливаются во внутреннем аккумуляторе.
3. **Fail-Fast инвариант (AP-012):** Если размер текущего непрерывного аккумулятора превышает `MAX_FRAME_BYTES`, парсер не пытается продолжить чтение, а немедленно сбрасывает буфер, выбрасывает типизированную ошибку `FrameOverflowError` и переводит транспорт в режим сброса ошибочного фрейма до следующего разделителя `\n`.

```typescript
// src/runner/transport/frame-codec.ts

import { StringDecoder } from "node:string_decoder";
import { MAX_FRAME_BYTES } from "./types.ts";

export class FrameOverflowError extends Error {
  readonly code = "FRAME_TOO_LARGE";
  constructor(size: number) {
    super(`Frame size ${size} bytes exceeds maximum limit of ${MAX_FRAME_BYTES} bytes`);
    this.name = "FrameOverflowError";
  }
}

export class StreamFrameCodec {
  private decoder = new StringDecoder("utf8");
  private buffer = "";

  public feed(chunk: Buffer, onFrame: (line: string) => void): void {
    this.buffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_FRAME_BYTES) {
      this.buffer = "";
      throw new FrameOverflowError(Buffer.byteLength(this.buffer, "utf8"));
    }

    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (Buffer.byteLength(this.buffer, "utf8") > MAX_FRAME_BYTES) {
        this.buffer = "";
        throw new FrameOverflowError(Buffer.byteLength(this.buffer, "utf8"));
      }

      if (line.length > 0) {
        onFrame(line);
      }
    }
  }

  public reset(): void {
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
  }
}
```

### 3.3. Управление Backpressure (Обратное давление)
При передаче больших объемов данных (снапшоты дерева рантайма `RuntimeGraphSnapshot`, крупные диффы файлов `patch_file`, большие текстовые генерации моделей) потребитель (Beyond Boundaries IDE) может не успевать обрабатывать поток сообщений.
- Каждый вызов `stream.write()` в Node.js проверяет заполнение внутреннего буфера `writableLength`.
- Если `stream.write()` возвращает `false`, буфер превысил `highWaterMark`.
- `ITransport` регистрирует ожидание промиса `waitForDrain()`:
  ```typescript
  // src/runner/transport/drain-barrier.ts

  import { EventEmitter } from "node:events";

  export async function writeWithBackpressure(
    stream: NodeJS.WritableStream,
    data: string | Buffer
  ): Promise<void> {
    const canContinue = stream.write(data);
    if (!canContinue) {
      await new Promise<void>((resolve) => {
        stream.once("drain", () => resolve());
      });
    }
  }
  ```
- Это предотвращает бесконтрольный рост heap memory раннера и блокирует накопление миллионов невыгруженных байт в очереди процесса.

### 3.4. Реализация `StdioTransport` (Embedded Mode)
Класс `StdioTransport` инкапсулирует работу с `process.stdin` и `process.stdout`.
- Сохраняет интеграцию со `setupRunnerStdoutGuard()` (`src/runner/stdout-guard.ts`), что гарантирует подавление нежелательного вывода дочерних процессов (например, при вызове инструментов bash или npm).
- Вызов `broadcastEvent()` транслируется в запись в `process.stdout` (Wire Events).
- Вспомогательный служебный канал (ранее FD 3 / FD 4) абстрагируется как типизированный фрейм протокола или мультиплексируется через префикс дескрипторов при наличии поддержки системных дескрипторов хостом.

### 3.5. Реализация `UnixSocketTransport` (Socket / Daemon Mode)
Класс `UnixSocketTransport` открывает локальный сервер сокетов Unix (`net.createServer`):
- **Слушающий сокет:** Путь к файлу сокета размещается в защищенной директории.
- **Одиночное эксклюзивное активное соединение:**
  В один момент времени к сессии может быть подключен ровно один клиент Beyond Boundaries IDE (`Exclusive Attached Client`).
  Если к уже подключенному сокету пытается подключиться второй клиент:
  - Сервер проверяет статус существующего клиента.
  - Если существующий сокет активен, новому клиенту возвращается ошибка рукопожатия `{ success: false, error: "SESSION_ALREADY_ATTACHED", activeClientPid: ... }`, после чего сокет нового клиента закрывается.
- **События сокета:** При разрыве сокета (`socket.on("close")`, `socket.on("end")`) транспорт генерирует событие `clientDetached(session, "SOCKET_DISCONNECTED")`. Никакого завершения работы раннера не происходит.

### 3.6. Безопасность и разграничение прав доступа к Unix Socket (AP-016)
Для исключения несанкционированного доступа локальных процессов других пользователей ОС:
1. **Права на родительскую директорию:** Папка размещения сокета создается со строгой маской `0o700` (`rwx------`). Чтение, запись и поиск разрешены исключительно текущему пользователю ОС (`process.getuid()`):
   ```typescript
   await fs.mkdir(socketDir, { recursive: true, mode: 0o700 });
   ```
2. **Права на файл сокета:** При создании сервера сокетов после вызова `server.listen(socketPath)` права на файл сокета немедленно устанавливаются в `0o600` (`rw-------`):
   ```typescript
   await fs.chmod(socketPath, 0o600);
   ```
3. **Проверка UID сокета:** Перед подключением клиент Beyond Boundaries валидирует атрибуты файла сокета:
   ```typescript
   const stat = await fs.stat(socketPath);
   if (!stat.isSocket()) throw new Error("Target path is not a valid unix socket");
   if (stat.uid !== process.getuid()) {
     throw new SecurityAccessDeniedError("Socket file is owned by different user UID");
   }
   ```
4. **Криптографический Shared Token рукопожатия (Defense in Depth):**
   Демон генерирует криптографически стойкий одноразовый секретный ключ сессии (`authToken = randomBytes(32).toString("hex")`) и записывает его в файл дескриптора `shared-host.json` (с правами `0o600`).
   При подключении к сокету первый фрейм от клиента обязан содержать `{ method: "session_attach", authToken: "..." }`. Если токен не совпадает, соединение немедленно уничтожается (`socket.destroy()`).

---

## 4. Модель владения хранилищем (Single Storage Owner) и SQLite WAL

### 4.1. Разделение ответственности
В соответствии с правилами AP-033 и AP-034, конкурентный доступ к данным должен исключать коррупцию хранилища:
- **Демон (Server Daemon) — Sole Writer:** Процесс демона является единственным компонентом, удерживающим эксклюзивную файловую блокировку `proper-lockfile` на директорию сессии и выполняющим операции записи (`INSERT`, `UPDATE`, `DELETE`, FSM transitions, Chord commits) в `session.sqlite`.
- **Beyond Boundaries Host — Zero Direct Writes:** Хост-процесс Beyond Boundaries IDE категорически лишен права осуществлять прямые записи в SQLite базу данных запущенной сессии. Все мутации выполняются исключительно через отправку JSON-RPC команд в сокет демона.

### 4.2. Поведение при одновременных попытках доступа
Алгоритм захвата блокировки модифицируется для поддержки режима Attached:
```typescript
// Алгоритм входа в сессию:
1. Вычисление директории сессии: dir = resolveSessionDir(sessionKey).
2. Проверка наличия `shared-host.json`:
   a. Файл существует -> чтение { pid, socketPath, authToken }.
   b. Проверка активности процесса через `isProcessAlive(pid)`.
   c. Процесс жив -> режим ATTACHED:
      - НЕ пытаться вызывать `proper-lockfile.lock(dir)`.
      - Инициировать сокет-соединение к `socketPath`.
   d. Процесс мертв (Stale Daemon) -> переход к процедуре восстановления:
      - Удаление осиротевшего сокета `socketPath`.
      - Удаление `shared-host.json`.
      - Принудительное снятие `proper-lockfile` (forceUnlock).
3. Процесс демона запускается и вызывает `proper-lockfile.lock(dir)`:
   - Захват блокировки директории.
   - Запись `session.owner.json` и `shared-host.json`.
   - Инициализация SQLite базы данных.
```

### 4.3. Поддержка холодного чтения хостом (Cold Read-Only via SQLite WAL)
В определенных сценариях (индексация дерева тредов, восстановление истории сессии после перезапуска IDE, предварительный расчет токенов) хосту Beyond Boundaries требуется быстро прочитать состояние базы данных без обращения к сокету демона.
- **Инвариант SQLite WAL:** Демон при старте сессии настраивает базу данных:
  ```sql
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  ```
- **Правило неблокирующего чтения (AP-034):** В режиме WAL читатели не блокируют писателей, а писатели не блокируют читателей.
- Хост Beyond Boundaries может открыть базу данных через встроенный модуль `node:sqlite`:
  ```typescript
  import { DatabaseSync } from "node:sqlite";

  export function openSessionColdReadOnly(sqlitePath: string): DatabaseSync {
    return new DatabaseSync(sqlitePath, {
      readOnly: true,
      enableForeignKeyConstraints: false,
    });
  }
  ```
- **Строгий запрет:** Хосту запрещено выполнять транзакции типа `BEGIN IMMEDIATE` или `BEGIN EXCLUSIVE` на cold read дескрипторе. Любые запросы должны быть строго `SELECT`.

---

## 5. Жизненный цикл соединений: Семантика Detach vs Abort

### 5.1. Фундаментальная демаркация: Detach против Abort
Главная концептуальная ошибка наивных адаптеров — приравнивание закрытия сетевого сокета к аварийной остановке агента.
Мы вводим строгое разграничение семантики:

| Событие / Действие | Инициатор | Семантика в Демоне | Состояние задач | Реакция хранилища SQLite |
|---|---|---|---|---|
| **Закрытие вкладки / Рестарт IDE** | Клиент (BB) | **DETACH (Отключение)** | **Продолжают исполняться.** LLM генерирует ответ, инструменты исполняются, FSM совершает переходы. | Сессия фиксирует события в штатном режиме WAL. |
| **Падение сокета (`ECONNRESET`)** | Сеть / ОС | **DETACH (Авария транспорта)** | **Продолжают исполняться.** Демон переходит в статус `detached`, буферизует события. | Запись не прерывается. |
| **Кнопка «Stop» в чате Beyond Boundaries** | Пользователь | **ABORT (Прерывание)** | **Немедленная остановка.** Отмена LLM запроса через AbortController, остановка сабагентов. | Фиксация прерванных элементов, статус `session.ended`. |
| **Команда `thread/stop` (`intent: release`)** | Хост BB | **DETACH (Освобождение)** | Задачи продолжаются в фоне (или завершаются штатно). | Клиент отключается от сокета. |
| **Команда `thread/stop` (`intent: interrupt`)** | Хост BB | **ABORT (Принудительный стоп)** | Принудительная остановка текущего хода (`turn`). | Запись незавершенных шагов с пометкой `interrupted`. |

### 5.2. Протокол повторного подключения (Reattach Handshake Protocol)

```
Beyond Boundaries IDE (Host)                       Pi Durable Server Daemon
         │                                                    │
         │ 1. net.connect(socketPath)                         │
         ├───────────────────────────────────────────────────►│
         │                                                    │
         │ 2. REATTACH_REQUEST (JSON-RPC)                     │
         │    method: "session/attach"                        │
         │    params: {                                       │
         │      authToken: "sec_9f83...",                     │
         │      threadId: "thr_123",                          │
         │      lastReceivedSeq: 42                           │
         │    }                                               │
         ├───────────────────────────────────────────────────►│
         │                                                    │ 3. Validate Token & UID
         │                                                    │ 4. Register Active Client
         │                                                    │ 5. Collect Catch-Up Events
         │ 6. REATTACH_RESPONSE (JSON-RPC)                    │
         │    result: {                                       │
         │      status: "attached",                           │
         │      isStreaming: true,                            │
         │      activeTurnId: "turn_99",                      │
         │      runtimeGraphSnapshot: { ... },                │
         │      durableViewState: { ... },                    │
         │      subagentMirrors: [ ... ],                     │
         │      missedEvents: [ ...events from seq 43... ]    │
         │    }                                               │
         │◄───────────────────────────────────────────────────┤
         │                                                    │
         │ 7. Hydrate Timeline & Resynchronize State          │
         │ 8. Real-time Event Streaming Resumes               │
         │◄═══════════════════════════════════════════════════┤
```

#### Детализация шагов Reattach Handshake:
1. **Кольцевой буфер недавних событий (In-Memory Event RingBuffer):**
   Демон хранит в оперативной памяти последние $K = 500$ событий wire-протокола с монотонно растущими номерами последовательности (`seq`).
2. При вызове `session/attach` клиент указывает `lastReceivedSeq` (номер последнего события, отрисованного в UI).
3. Демон мгновенно отдает слайс `missedEvents = events.filter(e => e.seq > lastReceivedSeq)`.
4. Если клиент отсутствовал слишком долго и нужные события вытеснены из кольцевого буфера (`lastReceivedSeq < oldestSeq`):
   - Демон передает флаг `fullRehydrateRequired: true`.
   - Вместе с ответом передается полный снимок состояния `durableViewState` и `runtimeGraphSnapshot`.
   - Хост вызывает метод `translator.rehydrateFromSnapshot()` и полностью восстанавливает дерево элементов без дублирования ходов.

### 5.3. Обработка явного прерывания (Abort Intent)
Когда пользователь нажимает кнопку «Stop Generation» в Beyond Boundaries:
1. Хост посылает в сокет команду:
   ```json
   {
     "id": "req_stop_1",
     "type": "abort",
     "intent": "interrupt",
     "conversationId": "root"
   }
   ```
2. Демон получает команду `abort`:
   - Вызывает `activeDurable.abort(conversationId)`.
   - Прерывает исполнение активного генератора через AbortSignal.
   - Помечает незавершенные вызовы инструментов как `interrupted`.
   - Сохраняет точку восстановления в SQLite (`checkpoint`).
   - Отправляет клиенту ответ `{ success: true, checkpointId: ... }` и wire-событие `{ kind: "session.ended", reason: "user_interrupt" }`.

---

## 6. Архитектура Standalone Daemon

### 6.1. CLI-интерфейс и запуск демона
Для запуска демона проектируется легковесный entry point:
`src/runner/daemon.ts` (скомпилированный в `dist/runner/daemon.js`), а также поддержка флага `--daemon` в основном `src/runner/index.ts`.

#### Аргументы командной строки:
```bash
node dist/runner/daemon.js \
  --cwd /Users/vanya/Projects/my-service \
  --session 1729200000000-abcd-1234 \
  --socket /Users/vanya/.pi/agent/run/my-service/daemon.sock \
  --idle-timeout 3600 \
  --provider antigravity \
  --model gemini-3.8-flash \
  --thinking high
```

- `--cwd`: Рабочая директория целевого проекта.
- `--session`: Идентификатор сессии или путь к директории хранения. Если не указан — создается новая сессия.
- `--socket`: Явный путь к Unix Domain Socket. Если не указан — генерируется детерминированный путь в системной runtime-директории.
- `--idle-timeout`: Время в секундах бездействия демона без подключенных клиентов перед автоматической грациозной остановкой (по умолчанию: `0` — бессрочно).

### 6.2. Дескриптор сессии `shared-host.json`
При успешном старте и захвате SQLite lockfile демон атомарно создает файл дескриптора в директории сессии:
`~/.pi/agent/experimental/durable-sessions/<hash>/<session-id>/shared-host.json`.

```json
{
  "version": 1,
  "pid": 58492,
  "protocol": "pi-durable-socket-v1",
  "socketPath": "/Users/vanya/.pi/agent/run/e8f9a102c/daemon.sock",
  "authToken": "4c3b2a1f09e8d7c6b5a4938271605f4e3d2c1b0a9f8e7d6c5b4a39281706f5e4",
  "startedAt": 1729201500234,
  "cwd": "/Users/vanya/Projects/my-service",
  "sessionId": "1729201500234-7a1b-4c2d-9e3f-112233445566",
  "status": "ready",
  "model": {
    "provider": "antigravity",
    "id": "gemini-3.8-flash"
  }
}
```

Файл записывается через временный файл и атомарный `fs.rename` с правами `0o600`. При завершении работы демона файл гарантированно удаляется.

### 6.3. Обработка сигналов ОС и грациозный останов (Graceful Drain)
Демон перехватывает сигналы завершения операционной системы: `SIGTERM`, `SIGINT`, `SIGHUP`.

```typescript
// Алгоритм Graceful Shutdown демона:
1. isTerminating = true (блокировка приема новых команд).
2. Остановка сервера сокетов: server.close() (прекращение приема новых подключений).
3. Уведомление подключенного клиента:
   broadcastEvent({ type: "daemon_terminating", reason: signal });
4. Завершение активных подписок:
   activeGraphSource.teardown();
   activeTaskBridge.unsubscribe();
   activeWatcher.close();
5. Дренирование FSM ядра Durable:
   Ожидание завершения текущей транзакции SQLite с жестким тайм-аутом (5000 мс).
6. Закрытие базы данных:
   await activeDurable.close();
7. Очистка файловой системы:
   await fs.unlink(socketPath).catch(suppressEnoent);
   await fs.unlink(sharedHostJsonPath).catch(suppressEnoent);
   await releaseLockfile();
8. process.exit(0).
```

---

## 7. Интеграция в Host Provider Bridge (`src/host/`)

### 7.1. Автодетекция режима (Embedded vs Attached)
В классе `SessionRegistry` (`src/host/session-registry.ts`) логика резолвинга раннера обновляется:

```
                  Входящий запрос на сессию (createOrGet)
                                   │
                                   ▼
             Задана переменная BB_PI_DURABLE_SOCKET?
                    │                      │
                   ДА                     НЕТ
                    │                      │
                    ▼                      ▼
           Прямое подключение      Существует ли shared-host.json
           к указанному сокету      в папке сессии?
                                           │
                                   ┌───────┴───────┐
                                  ДА              НЕТ
                                   │               │
                                   ▼               ▼
                       isProcessAlive(pid) == true?   Запуск Embedded
                                   │               RunnerProcess
                           ┌───────┴───────┐       (Режим по умолчанию)
                          ДА              НЕТ
                           │               │
                           ▼               ▼
                   Проверка сокета   Очистка stale-дескриптора
                     через ping       и запуск Embedded
                           │          RunnerProcess
                   ┌───────┴───────┐
                  OK             FAIL
                   │               │
                   ▼               ▼
             Режим ATTACHED   Fallback в Embedded
             (RunnerSocket)   (RunnerProcess)
```

### 7.2. Абстракция `IRunnerConnection` на стороне хоста
Хост абстрагирует связь с раннером через общий интерфейс, благодаря чему класс `PiThreadSession` полностью избавляется от прямой зависимости от `ChildProcess`:

```typescript
// src/host/transport/runner-connection.ts

import type { RunnerEvent } from "./types.ts";
import type { RunnerChannelFrame } from "../contracts/runner-channel.ts";
import type { RunnerProtocolError } from "./runner-protocol-error.ts";

export interface RunnerConnectionEvents {
  event: (event: RunnerEvent) => void;
  channelMessage: (msg: RunnerChannelFrame) => void;
  protocolError: (error: RunnerProtocolError) => void;
  error: (err: Error) => void;
  exit: (code: number | null, signal: NodeJS.Signals | null) => void;
  detach: (reason: string) => void;
}

export interface IRunnerConnection {
  readonly mode: "embedded" | "attached";
  readonly isConnected: boolean;
  request(cmd: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  requestOk(cmd: Record<string, unknown>, timeoutMs?: number): Promise<any>;
  sendChannelMessage(msg: Record<string, unknown>): void;
  closeGracefully(): Promise<void>;
  kill(signal?: NodeJS.Signals): void;
  on<K extends keyof RunnerConnectionEvents>(event: K, listener: RunnerConnectionEvents[K]): this;
  off<K extends keyof RunnerConnectionEvents>(event: K, listener: RunnerConnectionEvents[K]): this;
}
```

- `RunnerProcess` реализует `IRunnerConnection` для встроенного режима (управляет жизненным циклом дочернего процесса).
- `RunnerSocketConnection` реализует `IRunnerConnection` для режима сокета:
  - Метод `closeGracefully()` в режиме `attached` посылает фрейм `{ type: "detach" }` и закрывает клиентский сокет, НЕ посылая `SIGTERM` демону!
  - Метод `kill()` закрывает сокет. Демон продолжает жить.
- **Ноль регрессий:** Для пользователей Beyond Boundaries, работающих в стандартном режиме без внешнего демона, логика выполнения остается 100% идентичной существующей проверенной кодовой базе.

---

## 8. Декомпозиция модулей и лимиты строк (AP-019)

В строгом соответствии с архитектурным правилом AP-019 (Soft limit: 150 строк, Hard limit: 200 строк в runner, 250 строк в host; 1 файл = 1 ответственность) декомпозиция новых и модифицируемых компонентов распределяется следующим образом:

### 8.1. Территория 4: Runner & Transport (`src/runner/`)

| Файл | Назначение / Ответственность | Целевой объем |
|---|---|---|
| `src/runner/transport/types.ts` | Строгие типы, интерфейсы `ITransport`, `TransportSession`, ошибки переполнения. | ~80 строк |
| `src/runner/transport/frame-codec.ts` | NDJSON парсинг чанков, лимит 16 МиБ, UTF-8 декодер, обнаружение переполнения. | ~110 строк |
| `src/runner/transport/stdio-transport.ts` | Реализация `ITransport` поверх `process.stdin` / `process.stdout` с stdout-guard. | ~140 строк |
| `src/runner/transport/socket-security.ts` | Валидация прав доступа к сокету (`0o600`), права директории (`0o700`), проверка UID. | ~95 строк |
| `src/runner/transport/socket-transport.ts` | Реализация `net.Server`, обработка подключений, handshake, single active client. | ~180 строк |
| `src/runner/transport/event-ring-buffer.ts` | Хранение последних $K$ событий для ускоренного Reattach Handshake. | ~85 строк |
| `src/runner/daemon-descriptor.ts` | Атомарное создание, чтение, валидация и удаление файла `shared-host.json`. | ~115 строк |
| `src/runner/daemon-lifecycle.ts` | Обработка системных сигналов, drain активных задач, тайм-ауты остановки демона. | ~130 строк |
| `src/runner/daemon.ts` | Тонкая CLI entry-point точка запуска автономного демона. | ~75 строк |
| `src/runner/index.ts` *(рефакторинг)* | Тонкая сборка: выбор транспорта на основе флагов (`--socket`/`--daemon` vs stdio). | ~160 строк |

### 8.2. Территория 1: Beyond Boundaries Host (`src/host/`)

| Файл | Назначение / Ответственность | Целевой объем |
|---|---|---|
| `src/host/transport/runner-connection.ts` | Базовый интерфейс `IRunnerConnection` и фабрика подключений. | ~75 строк |
| `src/host/transport/daemon-detector.ts` | Поиск `shared-host.json`, проверка жизнеспособности PID, пинг сокета. | ~120 строк |
| `src/host/transport/runner-socket-connection.ts` | Реализация `IRunnerConnection` поверх `net.Socket` с поддержкой Reattach. | ~190 строк |
| `src/host/runner-process.ts` *(адаптация)* | Приведение `RunnerProcess` к контракту `IRunnerConnection` (0 регрессий). | ~185 строк |
| `src/host/session.ts` *(рефакторинг)* | Замена жесткого `RunnerProcess` на интерфейс `IRunnerConnection`. | ~195 строк |
| `src/host/session-registry.ts` *(адаптация)* | Внедрение автодетектора режима при вызове `createOrGet`. | ~210 строк |

Ни один файл не превышает лимит в 200/250 строк. Запрещены антипаттерны `common.ts` или `utils.ts` (AP-019).

---

## 9. Матрица сбоев и пограничных состояний (Failure Modes & TDD Matrix)

| ID | Пограничный случай / Сбой | Корневая причина (Root Cause) | Поведение системы и стратегия восстановления | Ожидаемый результат / Тестовый инвариант |
|---|---|---|---|---|
| **FM-1** | Внезапное падение демона (`kill -9`) во время выполнения генерации. | Внешнее принудительное завершение ОС или исчерпание памяти OOM. | Хост ловит `socket.on("close")` с кодом `ECONNRESET`. `RunnerSocketConnection` генерирует событие `exit(null, "SIGKILL")`. Хост переводит UI в статус `disconnected`, сохраняя ранее полученный контекст. База данных SQLite сохраняет целостность благодаря WAL-журналу. При следующем открытии stale lock очищается. | Тест: эмуляция `process.kill(daemonPid, "SIGKILL")`. Проверка: SQLite база валидна, хост выдает понятное уведомление в таймлайн без падения процесса BB. |
| **FM-2** | Закрытие вкладки или перезагрузка Beyond Boundaries (`Cmd+R`) посреди генерации. | Действие пользователя или рестарт UI-шелла. | Сокет разрывается. Демон фиксирует `clientDetached(reason: "SOCKET_CLOSED")`, переходит в статус `detached`. LLM-генерация и запись в SQLite **НЕ прерываются** и доходят до логического завершения. При повторном открытии вкладки Reattach Handshake восстанавливает готовый результат. | Тест: закрытие сокета клиентом во время активной записи мока LLM. Проверка: задача в демоне переходит в статус `completed`, результат записан в SQLite. |
| **FM-3** | Перегрузка сетевого буфера сокета медленным клиентом (Socket Congestion). | Хост-процесс Beyond Boundaries завис на тяжелом рендеринге DOM и не читает сокет. | В демоне `socket.write()` возвращает `false`. Активируется `writeWithBackpressure`, ожидающий события `drain`. Если буфер не освобождается более 30 секунд (тайм-аут зависания клиента), сокет принудительно разрывается, демон переходит в `detached` режим, защищая свой heap. | Тест: подключение искусственно «медленного» сокета (заблокированное чтение). Проверка: демон не падает по Out Of Memory, корректно сбрасывает зависшего клиента. |
| **FM-4** | Попытка подключения к сокету чужого пользователя ОС. | Локальная атака или ошибка разделения прав в multi-user Linux/macOS. | Клиент проверяет `fs.stat(socketPath).uid === process.getuid()`. При несовпадении выбрасывается `SecurityAccessDeniedError`. Демон проверяет секретный токен `authToken` из `shared-host.json` (доступного только владельцу с `0o600`). При ошибке сокет закрывается. | Тест: создание сокета с чужим UID или передача неверного `authToken`. Проверка: немедленный отказ `UNAUTHORIZED`, нулевая утечка данных. |
| **FM-5** | Получение фрейма, превышающего 16 МиБ (Frame Overflow). | Сбой сериализации, вредоносный ввод или гигантский неэкранированный вывод инструмента. | `StreamFrameCodec` обнаруживает превышение `MAX_FRAME_BYTES`. Выбрасывается `FrameOverflowError`. Поток дефектного фрейма сбрасывается. Хосту отправляется ошибка протокола `FRAME_TOO_LARGE`. Сессия не крашится. | Тест: подача в сокет непрерывной строки размером 17 МиБ без `\n`. Проверка: срабатывание защиты, генерация ошибки протокола, память процесса стабильна. |
| **FM-6** | Наличие мертвого файла сокета (Stale Socket File) после сбоя питания машины. | Файл сокета остался на диске, но процесс демона не существует. | Хост проверяет `shared-host.json` и `isProcessAlive(pid)`. Поскольку PID не существует, сокет признается мертвым, файл удаляется через `fs.unlink`, и происходит прозрачный fallback в запуск нового раннера. | Тест: создание фиктивного `.sock` файла и вызов детектора. Проверка: безопасное удаление осиротевшего файла и успешный старт. |
| **FM-7** | Попытка одновременного подключения двух окон Beyond Boundaries к одной сессии. | Пользователь открыл один и тот же тред в двух разных окнах IDE. | Второй клиент при попытке `session/attach` получает ответ с ошибкой `SESSION_ALREADY_ATTACHED`. Второе окно отображает режим Read-Only (холодное чтение через SQLite WAL) без права отправки управляющих команд `turn/start`. | Тест: параллельное подключение двух сокет-клиентов к одному демону. Проверка: первый удерживает управление, второй получает статус отказа. |

---

## 10. План реализации и контрольные фазы (Implementation Roadmap)

Реализация декомпозиции разбивается на 4 детерминированных инженерных цикла (Cycles) в рамках архитектурного процесса репозитория:

### Фаза 1 (Cycle 77): Абстракция `ITransport` и `FrameCodec` в Runner
- Реализация `src/runner/transport/types.ts` и `src/runner/transport/frame-codec.ts`.
- Реализация `src/runner/transport/drain-barrier.ts`.
- Реализация `src/runner/transport/stdio-transport.ts`.
- Адаптация `src/runner/index.ts` для работы через абстракцию `ITransport`.
- **TDD:** Unit-тесты кодека фреймов, проверка backpressure, тест на превышение лимита 16 МиБ.

### Фаза 2 (Cycle 78): `UnixSocketTransport` и Standalone Daemon
- Реализация `src/runner/transport/socket-security.ts` и `src/runner/transport/socket-transport.ts`.
- Реализация `src/runner/daemon-descriptor.ts` (`shared-host.json`) и `src/runner/daemon-lifecycle.ts`.
- Реализация точки входа `src/runner/daemon.ts`.
- **TDD:** Интеграционные тесты поднятия сервера сокетов, проверки прав доступа `0o600`/`0o700`, handshake с токеном авторизации.

### Фаза 3 (Cycle 79): Двухрежимный клиент и автодетекция в Host
- Реализация контракта `src/host/transport/runner-connection.ts`.
- Реализация `src/host/transport/daemon-detector.ts`.
- Реализация `src/host/transport/runner-socket-connection.ts` с алгоритмом Reattach Handshake.
- Приведение `src/host/runner-process.ts` к контракту `IRunnerConnection`.
- Обновление `src/host/session.ts` и `src/host/session-registry.ts`.
- **TDD:** Тестирование прозрачного переключения Embedded -> Attached при наличии `shared-host.json`.

### Фаза 4 (Cycle 80): Комплексные тесты надежности и стресс-тесты
- Реализация интеграционных тестов сценариев Detach vs Abort: закрытие сокета во время генерации, проверка сохранения задач в SQLite.
- Тестирование холодного чтения (Cold Read-Only) хостом через `node:sqlite`.
- Верификация всех лимитов строк модулей по правилу AP-019.
- Архитектурное ревью независимым сабтредом по правилам AP-010 – AP-071.

---

## 11. Заключение

Предложенная архитектурная спецификация кардинально решает проблему автономности и надежности раннера Pi Durable:
1. **Элегантность и чистота:** Проблема решается на правильном уровне абстракции (Ports & Adapters) без единой строчки хаков ядра Beyond Boundaries Core и без привязки к псевдотерминалам Linux.
2. **Нулевой риск для существующих пользователей (Zero Regression):** Режим Embedded сохраняется как стабильный дефолт из коробки.
3. **Автономность профессионального уровня:** Разработчики (включая сценарии Андрея / Diffuzmetall) получают возможность запускать раннер как полноценный фоновый демон в терминале, Docker-контейнере или удаленном сервере и бесшовно подключать Beyond Boundaries IDE через защищенный сокет Unix с гарантией сохранения контекста при любых сбоях клиентского интерфейса.
