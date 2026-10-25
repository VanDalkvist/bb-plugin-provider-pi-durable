# Pi Durable Provider Plugin for BB IDE

Run BB IDE threads with the **Pi Durable** transactional ACID SQLite engine and persistent conversation sessions.

## Overview

`bb-plugin-provider-pi-durable` is an atomic, self-contained provider plugin that integrates the Pi Durable runtime into the Beyond Boundaries (BB IDE) environment.

Unlike transient providers that store state only in memory or flat text logs, every thread in Pi Durable is backed by a transactional SQLite store (`session.sqlite`). This guarantees zero token loss on crashes or process termination (`kill -9`), deterministic thread resumption, a persistent task graph, and subagent orchestration.

The plugin includes an internal, pre-bundled RPC bridge runner (`dist/runner/index.js`), eliminating the need for custom external binaries or repository checkouts on user machines.

---

## Architecture & Philosophy: The Four Territories & Thin Bridge Invariant

A core architectural invariant of this plugin is that **it remains a thin, transparent protocol bridge** rather than an opinionated "god-plugin" that dictates which tools or MCP servers you must use. The system functions across four strictly separated territories:

```
┌────────────────────────────────────────────────────────────────────────┐
│ Territory 1: BB IDE (Host & UI Surface)                                │
│ • Contracts: Plugin SDK, JSON-RPC (turn/start, turn/delta, thread/stop)│
│ • UI widgets: diff viewer, thinking accordion, context window meter    │
│ • Owned by: BB Desktop Application & Host Daemon                       │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ (JSON-RPC stdio)
┌──────────────────────────────────▼─────────────────────────────────────┐
│ Territory 4: The Provider Plugin (bb-plugin-provider-pi-durable)       │
│ • SOLE LEGITIMATE ROLE: Pure Bidirectional Adapter (GoF Adapter)       │
│ • Translates BB JSON-RPC requests ──► Pi Durable Harness commands      │
│ • Translates FSM AgentEvent/docs ──► BB WireEvents & chat deltas       │
│ • DOES NOT OWN: prompt texts, agent rules, or core domain mechanics    │
└──────────────────┬─────────────────────────────────┬───────────────────┘
                   │                                 │
                   │ (Durable API)                   │ (Settings & Ext)
┌──────────────────▼───────────────┐ ┌───────────────▼───────────────────┐
│ Territory 2: Pi Durable Core    │ │ Territory 3: Pi Ecosystem / CLI   │
│ (@earendil-works/pi-durable)     │ │ (@earendil-works/pi-coding-agent) │
│ • FSM tasks (Generation, Tool)   │ │ • SettingsManager, MCP discovery  │
│ • ACID SQLite WAL persistence    │ │ • ModelRuntime, provider catalogs │
│ • CoW forks, document mounts     │ │ • Tool definitions, skills, rules │
│ • Deterministic replay           │ │ • ~/.pi/agent/settings.json       │
└──────────────────────────────────┘ └──────────────────────────────────┘
```

### Upstream Primitives Boundary (`src/runner/upstream/`)
Because `@earendil-works/pi-durable` is designed as a low-level computation engine rather than a finished agent application, several primitives (such as foreground subagents and multi-process SQLite session lockfile management) exist upstream only in `packages/coding-agent/src/experimental/durable/`. 

To prevent domain pollution, all such unexported upstream prototypes are quarantined into `src/runner/upstream/` with explicit provenance. The plugin never masquerades upstream primitives as provider-specific logic.

---

## Features

- **Self-Contained & Atomic:** Ships with its own built-in runner; no external `pi-durable-rpc` binary or mono-repo clones required.
- **ACID Session Persistence:** All turns, tool executions, and model generations are committed directly to disk using transactional SQLite (`node:sqlite`).
- **Interactive Terminal Widget:** Real-time bash command streaming with live stdout/stderr, working directory, and exit code display.
- **Visual File Diffs:** Full syntax-highlighted Diff Viewer in BB chat for `edit` and `write` tool calls.
- **Reasoning Stream Accordion:** Real-time thinking and reasoning blocks streamed directly into the collapsible Thinking accordion in BB UI.
- **Context Window Meter:** Accurate live token usage (`usedTokens / contextWindow`) rendered on the status bar ring indicator.
- **Full CLI & Workflow Output:** Guaranteed final output capture for `bb thread output <thread-id>` and automated workflows.
- **Model Selector & Reasoning Control:** Seamless model switching across providers (Google Antigravity, Anthropic, OpenAI) with multi-level thinking control (`none`, `low`, `medium`, `high`, `xhigh`, `max`).
- **Transparent MCP & Tool Discovery:** User-configured MCP servers (`~/.pi/agent/mcp.json`) and tools (`settings.json`) are automatically mounted without plugin-level overhead.

---

## System Requirements & Architectural Responsibility Audit

We maintain a strict separation between **what the user is responsible for** and **what the provider plugin delivers out of the box**:

### What the User Provides
1. **BB IDE:** `>= 0.45.0`
2. **Node.js:** `>= 22.19.0` (required for built-in `node:sqlite` support in the runner)
3. **Model Authentication via Pi CLI:** Authenticate your desired model providers (Google Antigravity, Anthropic, OpenAI) using the standard `pi` CLI:
   ```bash
   pi
   ```
   *(Credentials and default models are stored in `~/.pi/agent/auth.json` and `settings.json`).*
4. **Tool & MCP Configuration (Optional):** Define external MCP servers in `~/.pi/agent/mcp.json` or enable `codemode` in `settings.json`. The user retains 100% policy control.

### What the Plugin Delivers (Zero Extra Setup)
- **Pre-bundled Pi Durable Runtime:** Includes `@earendil-works/pi-durable` and `@earendil-works/pi-coding-agent` dependencies; **no global `npm install -g @earendil-works/pi-durable` is needed**.
- **Automated Host Process Lifecycle:** Automatically manages, discovers, and communicates with background runner processes.
- **Transactional SQLite Storage:** Automatic session directory management under `~/.bb/pi-bridge-sessions/`.
- **Bidirectional Event Translation:** Complete mapping between Pi Durable FSM events and BB chat UI components.

---

## Subagent Model Policy (Настройки субагентов)

В настройках плагина (Settings → Installed plugins → Pi Durable → Субагенты) доступно централизованное управление моделью и уровнем рассуждений для нативных субагентов (`subagent` tool):

- **Режимы политики:**
  - `inherit` (по умолчанию): нативный субагент наследует модель и уровень рассуждений родительского агента.
  - `configured`: нативный субагент использует явно выбранную фиксированную модель и уровень рассуждений.
- **Глобальная область действия:** Сохранённая политика хранится в KV плагина (`subagent.policy.v1`) и действует глобально для всех новых субагентов на сервере BB.
- **Контекст предпросмотра:** Селектор хоста и окружения в UI управляет исключительно предпросмотром доступного каталога моделей и не меняет глобальный характер сохранённой политики.
- **Доставка и применение:** Новая политика вступает в силу со следующего хода владельца (owner turn).
- **Неизменность созданных агентов:** Уже запущенные или завершённые дочерние беседы сохраняют свои исходные параметры (`model`, `thinkingLevel`) и никогда не мутируют ретроактивно.
- **Действие при отсутствии модели:** Если сконфигурированная модель недоступна на исполняющей машине (например, отсутствуют ключи авторизации), выполнение завершается понятной ошибкой до создания дочерней беседы со ссылкой на настройки плагина.

---

## Updating the Plugin & Existing Threads

When `bb-plugin-provider-pi-durable` is updated in Beyond Boundaries (via marketplace update, `bb plugin update`, or local install), newly created independent threads run on the updated plugin version once activation succeeds. (Note that child subagent sessions spawned by an existing resident parent continue to share that parent's runtime).

However, **existing threads with an active provider session remain pinned by BB Core to their previous bridge process** to preserve session continuity ([BB issue #4942](https://github.com/get-bb/bb/issues/4942)). In BB Core, completing a turn or reaching `idle` state does not release this binding; sending a new message to an existing resident thread continues executing on the previous bridge process.

### Recommended Update Procedure

- **For Desktop-Managed Local Runtimes (where BB Desktop manages the local server and daemon):**
  1. **Before updating:** Wait for in-flight turns and background/subagent operations across your threads to settle. (Installing an update immediately reclaims previous cache artifacts, which can disrupt actively executing tools).
  2. Update or reinstall the plugin, and verify successful activation.
  3. Completely **Quit** the Beyond Boundaries application:
     - On macOS: Press **Cmd+Q** (or select *Beyond Boundaries → Quit* from the menu bar). *Note: Closing the window with the red close button or Cmd+W does not quit the application or release resident background runtimes.*
     - On Windows/Linux: Use the application's Quit / Exit menu command.
  4. Launch Beyond Boundaries again.
  5. Continue your existing threads. Committed SQLite conversation history and checkpoints are preserved; the next message in those threads will initialize on the newly activated plugin runtime without requiring context clearing or starting over in new chats.

- **For Remote, Standalone, or Attached Hosts (Headless Daemons, SSH, Remote Workspaces, or Local Standalone Servers):**
  - Quitting the desktop client does not restart the remote runtime processes.
  - Settle in-flight work before updating.
  - Coordinate a graceful restart of the specific service or process tree that owns the executing host-daemon / runtime (or the full stack where managed together). Restarting only a web/API server while leaving the host-daemon active will not release the bridge process. (Consult your infrastructure operator for the exact service unit; all active agent sessions hosted on that daemon will be interrupted).

---

## Configuration

The plugin works out-of-the-box with default paths, but supports optional environment overrides:

| Variable | Description | Default |
|---|---|---|
| `BB_PI_DURABLE_PACKAGE_PATH` | Explicit filesystem path to `@earendil-works/pi-durable` (useful for monorepos or local package checkouts). | Auto-discovered from project, global `npm root -g`, or `~/.pi/agent/`. |
| `BB_PI_DURABLE_BRIDGE_COMMAND` | Custom executable command for the bridge runner (for core engine developers). | Internal bundled runner (`dist/runner/index.js`). |
| `BB_PI_DURABLE_BRIDGE_ARGS` | JSON array of additional CLI arguments passed to the runner. | `[]` |

---

## Troubleshooting

### "Cannot find module 'quickjs-wasi/quickjs.wasm'" or ENOENT on worker assets
If tool execution fails on an existing resident thread after a plugin update with a module resolution or `ENOENT` error whose stack trace points to an old, replaced installation path, the resident process is likely attempting to lazily load assets from an unlinked previous plugin cache directory ([BB issue #4942](https://github.com/get-bb/bb/issues/4942); see also [#5483](https://github.com/get-bb/bb/issues/5483) for a similar asset-eviction report with external tools). Follow the [Updating the Plugin & Existing Threads](#updating-the-plugin--existing-threads) procedure to restart the runtime.

### "Pi has no authenticated model provider available"
Run `pi` in your terminal to log in to your desired provider (Google, Anthropic, OpenAI), then reload BB IDE.
Credentials are read automatically from `~/.pi/agent/auth.json`.

---

## License

MIT
