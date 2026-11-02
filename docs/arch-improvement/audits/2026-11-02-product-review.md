# Продуктовое ревью [S9b: Product Verify Gate]

**Дата:** 2026-11-02  
**Роль:** Независимый Product Reviewer (Arch Improvement Loop)  
**Объект тестирования:** Публичные интерфейсы CLI `@durable-zero/cli` (`durable-zero.js`), хост-интеграция `bb-plugin-provider-pi-durable@0.5.0`  
**Методология:** Строгий Black-Box Synthetic User Testing (AP-013, AP-028, нулевое инспектирование исходного кода и git diff).

---

## 1. Executed User Journeys

### 1.1. Happy Path (Основной сценарий ценности)
1. **Диагностика окружения (`doctor`):**
   - **Команда:** `node /Users/vanya/Projects/durable-zero/packages/cli/bin/durable-zero.js doctor`
   - **Результат:** `PASS`
   - **Вывод:**
     ```
     durable-zero doctor: checking environment...
     - Node.js: v26.0.0
     - Platform: darwin (arm64)
     - SQLite WAL: Supported (Node.js native storage)
     - QuickJS WASI: Available
     - Socket Daemon: Available (Unix domain socket)
     HEALTHY: All durable-zero core capabilities are operational.
     ```
   - **Код возврата:** `0`
   - **Оценка:** Вывод лаконичный, человекочитаемый, без когнитивного шума и внутренних дампов. Все ключевые подсистемы (SQLite WAL, QuickJS WASI, Socket Daemon) проверены и находятся в статусе Healthy.

2. **Интроспекция версии и справки (`--version`, `--help`, `-h`, `-v`):**
   - **Команды:**
     - `durable-zero --version` -> `durable-zero v0.1.0` (exit code `0`)
     - `durable-zero -v` -> `durable-zero v0.1.0` (exit code `0`)
     - `durable-zero --help` -> Справка с описанием и командами `run`, `serve`, `doctor`, `--version`, `--help` (exit code `0`)
     - `durable-zero -h` -> Справка (exit code `0`)
   - **Результат:** `PASS`
   - **Оценка:** Понятная справка с каноническими флагами POSIX CLI.

3. **Запуск демона и wire purity протокола (`serve --no-session`):**
   - **Команда:** `node /Users/vanya/Projects/durable-zero/packages/cli/bin/durable-zero.js serve --no-session`
   - **Результат:** `PASS`
   - **Wire Purity:** Первая строка в `stdout` — валидный чистый JSON без мусора и логов:
     ```json
     {"type":"ready","kind":"ready","pid":84458}
     ```
   - **Шум в stderr:** `0` байт (чистый канал).
   - **Сигнал завершения:** Корректная обработка `SIGTERM`, освобождение ресурсов, чистый exit code `0`.

4. **Статус хоста и плагина Beyond Boundaries (`bb status`, `bb plugins list`):**
   - **Команды:** `bb status`, `bb plugins list`
   - **Результат:** `PASS`
   - **Статус плагина:**
     ```
     provider-pi-durable@0.5.0  running
       source: git:https://github.com/VanDalkvist/bb-plugin-provider-pi-durable.git@semver:^0.5.0
     ```
   - **Оценка:** Плагин успешно загружен хостом BB в версии `0.5.0` и находится в статусе `running`.

---

### 1.2. Empty / Cold-Start (Сценарий отсутствия данных)
1. **Запуск без аргументов:**
   - **Команда:** `node /Users/vanya/Projects/durable-zero/packages/cli/bin/durable-zero.js`
   - **Результат:** `PASS`
   - **Вывод:** Вместо краша или немого завершения система выводит форматированное руководство по использованию (Usage guide).
   - **Код возврата:** `0`

2. **Запуск команды `run` без промпта:**
   - **Команда:** `node /Users/vanya/Projects/durable-zero/packages/cli/bin/durable-zero.js run`
   - **Результат:** `PASS`
   - **Вывод:**
     ```
     Error: prompt is required. Example: durable-zero run "Check git status"
     ```
   - **Код возврата:** `1`
   - **Оценка:** Четкое указание причины ошибки с готовым примером правильного вызова. Исключение перехвачено, стек-трейс не протек.

---

### 1.3. Error Recovery & Edge Cases (Сценарий устойчивости к ошибкам)
1. **Неизвестная команда:**
   - **Команда:** `node /Users/vanya/Projects/durable-zero/packages/cli/bin/durable-zero.js invalid-cmd`
   - **Результат:** `PASS`
   - **Вывод:**
     ```
     Unknown command: invalid-cmd

     durable-zero — The Sovereign ACID-Persisted Agent Runtime

     Usage:
       durable-zero run "<prompt>"        Execute an agent task in current directory
       durable-zero serve [--session id]  Start multi-client socket daemon & stdio server
       durable-zero doctor                Check system health, SQLite, and QuickJS Wasm
       durable-zero --version             Print runtime version
       durable-zero --help                Print this help message
     ```
   - **Код возврата:** `1`

2. **Отсутствие необработанных исключений и утечек:**
   - **Результат:** `PASS`
   - **Проверка процессов:** По завершении тестов отсутствуют фоновые зомби-процессы (`ps aux | grep durable-zero` вернул 0 процессов).
   - **Проверка файловых дескрипторов и сокетов:** Отсутствуют «висячие» временные файлы сокетов в `/tmp/durable-zero*`.

---

## 2. Findings

- **[P3] Неявное перенаправление позиционного аргумента субкоманды `serve` в runner-server**
  - **Journey:** Error Recovery / Exploratory Edge Case
  - **Action:** Запуск `durable-zero serve` или `durable-zero serve --session test` без флага `--no-session`.
  - **Expectation:** Если оператор запускает `durable-zero serve` из командной строки согласно справке (`durable-zero serve [--session id]`), система должна либо автоматически использовать `process.cwd()` как директорию рабочей области, либо валидировать обязательность флага `--no-session` / аргумента пути с понятным сообщением об ошибке.
  - **Reality:** Строка субкоманды `'serve'` попадает в качестве первого позиционного аргумента в `runner-server`, вызывая `ENOENT: no such file or directory, realpath '<cwd>/serve'`.
  - **Fix decision:** `log-only` (для Cycle 103 не является блокирующим дефектом, так как основной протокол wire serve в текущем цикле валидирован через явный флаг `serve --no-session`, а BB-плагин передает параметры напрямую; рекомендовано к полировке в CLI v0.2.0).

---

## 3. Product Verification

- **Primary Journey Complete:** `YES`  
  Все основные сценарии (`doctor`, `--version`, `--help`, `serve --no-session`, `bb plugins list`) успешно выполнены и возвращают ожидаемый результат.
- **Feedback & Error Clarity:** `YES`  
  Ошибки формулируются на понятном языке с примерами правильного вызова (напр., `Error: prompt is required. Example: durable-zero run "Check git status"`), системные исключения экранированы.
- **Clean State & Clean Exit:** `YES`  
  Корректная обработка сигналов `SIGTERM`, мгновенная остановка, нулевые утечки процессов или временных сокетов.
- **Residual User Risk:** `Низкий`. Публичные интерфейсы ядра и плагина `provider-pi-durable@0.5.0` стабильны, диагностика `doctor` подтверждает работоспособность всех подсистем рантайма.

---

## Итоговый вердикт

**VERDICT: PASS**
