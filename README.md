# Pi Durable Provider Plugin for BB

Run BB IDE threads with the Pi Durable ACID SQLite engine and persistent conversation sessions.

## Overview

`bb-plugin-provider-pi-durable` connects BB IDE to the Pi Durable runtime. Unlike standard transient processes, every thread run in Pi Durable is backed by an ACID SQLite store, preserving full event history, deterministic resumption, execution logs, and live state streaming.

## Features

- **ACID Session Persistence:** All turns, tool executions, and model generations are committed directly to disk using transactional SQLite storage.
- **Dynamic Model Catalog:** Seamlessly discovers all models configured in your Pi environment (Anthropic, OpenAI, OpenRouter, Google, Bedrock, and custom local models) without hardcoded models or artificial limitations.
- **Live Bidirectional Bridge:** Uses dedicated IPC channels (FD 3 & FD 4) for immediate readiness, model scope discovery, thinking level negotiation, and interactive UI requests.
- **Native Skill Roots:** Automatically resolves native skills from `.pi/agent/skills`, `.agents/skills`, and project-level roots.
- **Multi-Level Reasoning Support:** Supports all thinking levels (`none`, `low`, `medium`, `high`, `xhigh`, `max`) depending on model capabilities.

## Requirements

- BB IDE `>= 0.45.0`
- `pi` CLI installed and authenticated on the host machine.
- `pi-durable-rpc` available in `$PATH` (or customized via `BB_PI_DURABLE_BRIDGE_COMMAND`).

## Configuration

You can override the bridge launch command via environment variables:

- `BB_PI_DURABLE_BRIDGE_COMMAND`: Custom path to the `pi-durable-rpc` binary or runner.
- `BB_PI_DURABLE_BRIDGE_ARGS`: JSON array of additional CLI arguments.

## License

MIT
