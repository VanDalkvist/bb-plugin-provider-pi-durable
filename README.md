# Pi Durable Provider Plugin for BB IDE

Run BB IDE threads with the **Pi Durable** transactional ACID SQLite engine and persistent conversation sessions.

## Overview

`bb-plugin-provider-pi-durable` is an atomic, self-contained provider plugin that integrates the Pi Durable runtime into the Beyond Boundaries (BB IDE) environment.

Unlike transient providers that store state only in memory or flat text logs, every thread in Pi Durable is backed by a transactional SQLite store (`session.sqlite`). This guarantees zero token loss on crashes or process termination (`kill -9`), deterministic thread resumption, a persistent task graph, and subagent orchestration.

The plugin includes an internal, pre-bundled RPC bridge runner (`dist/runner/index.js`), eliminating the need for custom external binaries or repository checkouts on user machines.

---

## Architecture & Philosophy: Thin Bridge & User Policy Invariant

A core architectural invariant of this plugin is that **it remains a thin, transparent protocol bridge** rather than an opinionated "god-plugin" that dictates which tools or MCP servers you must use:

1. **Decoupled Roles:**
   - **Pi Durable Core Engine:** Responsible exclusively for execution reliability, ACID SQLite transactions, deterministic recovery across process crashes, instant branch forks on checkpoints (`EntryId`), and FSM-driven background compaction.
   - **Provider Bridge (`bb-plugin-provider-pi-durable`):** Translates events, tool cards, file diffs, reasoning streams, and token telemetry between the BB IDE host daemon and the Pi Durable runner.
   - **User Policy & Tool Configuration:** **The user retains 100% control.** The plugin does not hardcode third-party tools or force MCP connections.
2. **Transparent Standard Configuration:**
   - Tools, MCP servers, and Codemode are configured strictly through standard Pi configuration files:
     - `~/.pi/agent/settings.json` (e.g. `"defaultTools": ["+codemode"]`)
     - `~/.pi/agent/mcp.json` and project-level `.pi/mcp.json` (declaring external MCP servers)
   - If no MCP servers are configured in your environment, none are spawned, keeping your runtime lightweight and zero-overhead. If configured, they are resolved transparently through Pi's native discovery without plugin bloat.

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
- **Project Guidelines Injection:** Automatically injects project-level `AGENTS.md` and custom thread instructions.

---

## System Requirements & Prerequisites

To use Pi Durable in BB IDE, ensure the following prerequisites are installed on your host machine:

1. **BB IDE:** `>= 0.45.0`
2. **Node.js:** `>= 22.19.0` (required for built-in `node:sqlite` support)
3. **Pi Durable Core Engine:** Install the `@earendil-works/pi-durable` package:
   ```bash
   npm install -g @earendil-works/pi-durable
   ```
4. **Model Authentication:** Authenticate your model providers using the standard `pi` CLI:
   ```bash
   pi
   ```
   *(Ensure at least one provider such as Google Antigravity, Anthropic, or OpenAI is logged in).*

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

### "Could not find @earendil-works/pi-durable"
If the plugin reports that Pi Durable is not installed:
1. Run `npm install -g @earendil-works/pi-durable` on your machine.
2. If installed in a non-standard location or monorepo, set `BB_PI_DURABLE_PACKAGE_PATH=/path/to/@earendil-works/pi-durable`.

### "Pi has no authenticated model provider available"
Run `pi` in your terminal to log in to your desired provider (Google, Anthropic, OpenAI), then reload BB IDE.

---

## License

MIT
