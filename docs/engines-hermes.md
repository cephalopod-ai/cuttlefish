# Hermes Engine

Hermes is [NousResearch's open-source `hermes` CLI](https://hermes-agent.nousresearch.com/) — a model-agnostic, self-improving agent that manages its own tool loop, memory, and skills. Cuttlefish wires Hermes in as a first-class engine: two complementary modes handle streaming chat work and terminal-view sessions.

> **Metered cost.** Unlike the subscription-wrapped engines (claude, codex, grok), Hermes owns its own model loop and bills **per token** on the provider you configure in `~/.hermes`. Make sure you understand your provider's pricing before running Hermes on high-volume tasks.

---

## Installation

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

Credentials and provider configuration live in `~/.hermes` (`.env` and/or `auth.json`). Cuttlefish only resolves the binary from `PATH`; all model-provider wiring is the CLI's own concern.

---

## Two Modes

### Chat Mode — `HermesAcpEngine`

The primary work engine. Cuttlefish spawns `hermes acp` once per session and communicates with it over **ndjson JSON-RPC 2.0** (the Agent Client Protocol, ACP). The process is kept warm across turns so context and Hermes's own memory survive between messages.

- Real token streaming via `session/update` notifications
- Auto-approves all permission requests (see [Auto-approve](#auto-approve))
- Handles model switching mid-session via `session/set_model`

### CLI Mode — `HermesInteractiveEngine`

Opens `hermes chat --cli --yolo --accept-hooks` inside a `node-pty` pseudo-terminal. The xterm.js view in the web dashboard attaches directly to this PTY, giving a live terminal window into the Hermes TUI.

**v1 is view-only.** Sending a work turn through CLI Mode returns an error; all actual turns are dispatched through Chat Mode (ACP).

---

## ACP Invocation Contract

Cuttlefish drives the ACP over a pair of stdio pipes using JSON-RPC 2.0. Each message is a single line terminated by `\n`.

### Methods used

| Method | Direction | Purpose |
|--------|-----------|---------|
| `initialize` | request | Handshake — declares protocol version and client capabilities. Called once when the process starts. |
| `session/new` | request | Create a new Hermes session. Response carries `sessionId` and the live model registry (`models.availableModels`, `models.currentModelId`). |
| `session/load` | request | Resume an existing Hermes session by `sessionId`. Used when the Cuttlefish session has a `resumeSessionId`. |
| `session/set_mode` | request | Called immediately after session creation with `modeId: "dont_ask"` to suppress all interactive prompts. |
| `session/set_model` | request | Switch the active model for a running session. Called before each turn when the requested model differs from the current one. |
| `session/prompt` | request | Send a user message and start a turn. Resolves when Hermes returns a response object containing `stopReason`. |

Hermes also sends **server requests** (`session/request_permission`). Cuttlefish answers every one with `{ outcome: { outcome: "selected", optionId: "allow_always" } }` — see [Auto-approve](#auto-approve).

### `session/update` → StreamDelta mapping

During a turn Hermes emits `session/update` notifications. Cuttlefish maps their `sessionUpdate` field to `StreamDelta` entries:

| `sessionUpdate` value | Mapped to | Notes |
|-----------------------|-----------|-------|
| `agent_message_chunk` / `agent_message_text` | `{ type: "text", content }` | The assistant's visible reply. (The `_chunk` form is what the live binary emits; `_text` is a tolerated legacy/compat variant.) |
| `agent_thought_chunk` / `agent_thought_text` | *(dropped)* | Internal reasoning — never forwarded as answer text. (The `_chunk` form is emitted live; `_text` is a tolerated legacy/compat variant.) |
| `tool_call` | `{ type: "tool_use", content: name, toolId, toolName, input }` | Tool invocation start. `input` is JSON-stringified and capped at 200 chars. |
| `tool_call_update` (status `completed` / `failed`) | `{ type: "tool_result", content: status, toolId }` | Tool result. Only `completed` and `failed` statuses are forwarded. |
| `usage_update` | `{ type: "context", content: String(used) }` | Token count update; also updates the session's `contextTokens` field. |
| all others | *(dropped)* | Unknown update kinds are silently ignored. |

---

## Live Model Discovery

When Cuttlefish starts a new Hermes session it reads the model list **directly from the `session/new` response** — no static config file, no version pinning.

The discovery flow:

1. `initialize` → handshake (protocol version 1).
2. `session/new` → response includes `models.availableModels[]` (each entry has `modelId` and `name`) and `models.currentModelId`.
3. Cuttlefish populates the model registry from this list. Model IDs follow the `provider:model` convention, e.g. `openai-codex:gpt-5.5`.

**Precedence.** The three sources are tried in order: live-discovered models (highest priority) → the optional `models.hermes` block in `~/.cuttlefish/config.yaml` (only consulted when discovery returns nothing) → the built-in static catalog (`openai-codex:gpt-5.5` and `openai-codex:gpt-5.4`) as the last resort. A configured `models.hermes` block does **not** override live discovery; it is only a fallback when the binary is unreachable or returns no models.

---

## Effort — None

Hermes has no reasoning-effort concept. `effortMechanism` is `"none"` and `effortLevels` is `[]`. The effort control is hidden in the Cuttlefish UI whenever a Hermes session is active. Passing an `effortLevel` to a Hermes session has no effect.

---

## Auto-approve

Every Hermes process (both modes) runs fully autonomously. Three layers enforce this:

| Layer | Mechanism |
|-------|-----------|
| Environment | `HERMES_YOLO_MODE=1` and `HERMES_ACCEPT_HOOKS=1` are injected into the process environment at spawn time. |
| ACP mode | `session/set_mode` is called with `modeId: "dont_ask"` immediately after each new session is created. |
| Permission handler | Cuttlefish registers an RPC server-request handler that answers every `session/request_permission` call with `{ outcome: { outcome: "selected", optionId: "allow_always" } }`. |

---

## Configuration

Both `bin` and `model` are optional — Cuttlefish synthesizes sensible defaults when they are absent.

```yaml
engines:
  hermes:
    bin: hermes               # path or binary name; defaults to "hermes" (PATH-resolved)
    model: openai-codex:gpt-5.5  # default model; overridden by live discovery
```

`bin` accepts any resolvable path or binary name. If omitted, Cuttlefish searches `PATH` plus common install directories. If the binary is not found, the `hermes` engine is marked unavailable and hidden from the UI.

`model` sets the initial default. After the first `session/new` succeeds, the live `currentModelId` from the handshake takes precedence for that session.

---

## Troubleshooting

**Engine not available / not shown in UI**
The `hermes` binary is not on `PATH`. Run `which hermes` to confirm. Install with:
```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```
Then restart the Cuttlefish gateway.

**Turns fail immediately at session start**
Provider credentials or model configuration are missing in `~/.hermes`. Check `.env` and `auth.json` in that directory and verify your provider endpoint and API key are set. Hermes's own docs cover provider setup.

**Model list empty or only shows fallback models**
Live discovery timed out (20 s) or the `hermes acp` process exited before returning `session/new`. Usually caused by a provider credential issue. Fix credentials, then restart the gateway or create a fresh session.
