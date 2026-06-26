# Hermes as a Cuttlefish Engine — Design Spec

**Date:** 2026-06-23
**Branch:** `feat/hermes-engine`
**Status:** Design — pending review

## 1. Goal

Add **Hermes Agent** (NousResearch, `hermes` CLI) as a first-class, selectable **engine** in
the Cuttlefish gateway, with **real token streaming** in the web chat and a **live CLI terminal
view** in the dashboard.

**Version- and path-agnostic.** Cuttlefish runs on other people's machines. The engine must use
**whatever `hermes` binary is found on the user's PATH** (resolved via `resolveBin("hermes",
opts.bin)`, like every other engine), regardless of version or install location. We do **not**
hardcode a version, an absolute path, or a fixed model list. Capabilities and models are
**discovered at runtime** from the CLI's own ACP handshake, so a newer/older Hermes simply
works with whatever it reports. The facts in §2 were captured against the locally installed
build (v0.17.0) to validate the integration — they are a reference snapshot, **not** a pinned
assumption. If a given machine has no `hermes` on PATH, the engine is simply unavailable
(hidden in the picker), exactly like an uninstalled codex/grok.

Two interaction modes, mirroring the existing Codex/Grok dual-engine pattern:

- **Chat Mode** — `HermesAcpEngine`: drives `hermes acp` (Agent Client Protocol, ndjson
  JSON-RPC 2.0 over stdio) as a **warm, per-session** subprocess. Runs work turns and
  streams `text` / `tool_use` / `tool_result` / `context` deltas into the web chat.
  Registered in the `engines` map → handles `run()`.
- **CLI Mode** — `HermesInteractiveEngine`: spawns the real `hermes` TUI in a `node-pty`
  for the dashboard "open terminal" tab. Registered in `ptyViewEngines`.

Both run **fully autonomous / auto-approving** (no human approval prompts).

## 2. Verified facts (reference snapshot — local build v0.17.0, 2026-06-23)

The following were confirmed by probing the locally installed binary and ACP server. They
document the protocol the adapter targets; the adapter relies on **runtime discovery**, not on
this exact version. ACP is a stable, versioned protocol (`initialize` negotiates
`protocolVersion`), so other Hermes builds present the same surface.

- **Transport:** `hermes acp` speaks **ndjson JSON-RPC 2.0** over stdio. One JSON object
  per line on stdout; all logs go to **stderr** (stdout stays clean). `hermes acp --check`
  returns `Hermes ACP check OK` (exit 0). A raw ndjson `initialize` + `session/new`
  handshake succeeded.
- **`initialize`** → advertises `loadSession:true`, `promptCapabilities.image:true`,
  `sessionCapabilities: { fork, list, resume }`. `authMethods` includes the configured
  `openai-codex` runtime.
- **`session/new` { cwd, mcpServers }** → returns in one payload:
  - `sessionId` (UUID) — the **resume handle**.
  - `models.availableModels[]` = `[{ modelId:"openai-codex:gpt-5.5", name:"gpt-5.5",
    description:"Provider: OpenAI Codex • current" }, gpt-5.4, gpt-5.4-mini,
    gpt-5.3-codex-spark]` + `currentModelId` — **the model-picker payload,
    machine-readable, and free** (no model invocation).
  - `modes.availableModes[]` = `default` / `accept_edits` / `dont_ask` + `currentModeId`
    (edit-approval policy — Hermes's per-session knob; **not** reasoning effort).
  - `_meta.hermes.sessionProvenance` (session lineage).
- **`session/update` notifications** stream automatically and during turns:
  - `usage_update` → `{ size: 272000, used: 11833 }` = **context window + tokens used**
    → maps to Cuttlefish `EngineResult.contextTokens` / a `context` `StreamDelta`.
  - `available_commands_update` → Hermes slash commands.
  - During a turn (from `acp_adapter/events.py`): `update_agent_message_text(text)` =
    streamed **answer** text; `update_agent_thought_text(text)` = **reasoning**;
    `tool_start` / `tool_complete`; `plan` (todo list). `prompt` resolves with a
    `stop_reason`.
- **Methods:** `initialize`, `authenticate`, `session/new`, `session/load` (resume),
  `session/prompt`, `session/cancel` (interrupt), `session/set_model`
  (`set_session_model`, line 1989), `session/set_mode` (`set_session_mode`, line 2023).
- **Auto-approve:** `HERMES_YOLO_MODE=1` (env) bypasses **all** dangerous-command approval
  prompts (set internally by `--yolo`; see `hermes_cli/main.py:2316`, `banner.py:659`).
  `HERMES_ACCEPT_HOOKS=1` / `--accept-hooks` auto-approves shell hooks. ACP dangerous
  commands otherwise trigger a client→ `session/request_permission` callback
  (`acp_adapter/permissions.py`) with options `allow_once|allow_session|allow_always|deny`.
- **Models are `provider:model` strings** (e.g. `openai-codex:gpt-5.5`); the available set
  is provider-dependent (`curated_models_for_provider`, live API + static fallback). The
  active provider here is `openai-codex` (model `gpt-5.5`, base
  `https://chatgpt.com/backend-api/codex`).
- **Effort:** Hermes has **no** reasoning-effort concept. Its per-session control is edit
  approval `modes`, not effort.
- **Hermes is metered** (owns its own model loop) — distinct from the subscription-wrapped
  claude/codex/grok engines. Cost rides on whatever provider `~/.hermes/config.yaml` points
  at (currently the Codex/gpt-5.5 endpoint).

## 3. Architecture

### 3.1 New modules

```
packages/cuttlefish/src/engines/
  hermes-protocol.ts   # PURE: JSON-RPC request builders + session/update → StreamDelta
                       # mappers + provider:model helpers. No I/O. Fully unit-testable.
  hermes-jsonrpc.ts    # Minimal ndjson JSON-RPC client over a child_process stdio pair:
                       # line-buffered reader, id→promise map for requests, notification
                       # dispatch, server→client request handler (request_permission).
  hermes-acp.ts        # HermesAcpEngine: InterruptibleEngine. Warm per-session `hermes acp`
                       # process pool; run() = session/new|load → set_mode(dont_ask) →
                       # session/prompt, streaming deltas via opts.onStream, settle on
                       # PromptResponse.stop_reason. kill/isAlive/killAll/killIdle.
  hermes-interactive.ts# HermesInteractiveEngine: PtyViewEngine over a PtyLifecycleManager,
                       # spawns `hermes chat --cli --yolo --accept-hooks` in node-pty for
                       # the xterm view. (CLI Mode.)
```

We **hand-roll** the minimal ndjson JSON-RPC client (no `@zed-industries/agent-client-protocol`
dependency) — the wire subset we need is tiny, it keeps Cuttlefish dependency-free and matches the
repo's hand-rolled style (the smoke test already proved raw ndjson works). `hermes-protocol.ts`
isolates all wire knowledge behind pure functions, exactly as `antigravity-protocol.ts` does.

### 3.2 Chat Mode — `HermesAcpEngine.run()` flow

1. **Get/warm the process.** Keep `Map<cuttlefishSessionId, HermesProc>` of long-lived `hermes acp`
   children (warm per-session). Spawn lazily on first turn with env
   `{ ...scrubbed, HERMES_YOLO_MODE:1, HERMES_ACCEPT_HOOKS:1 }`, cwd `opts.cwd`. On spawn:
   send `initialize`.
2. **Session.** If we have a Hermes `sessionId` for this Cuttlefish session (from a prior turn or
   persisted `engineSessionId`) and the process is fresh → `session/load`; else
   `session/new { cwd, mcpServers:[] }`. Capture `result.sessionId`, seed the model registry
   from `result.models` (first time), and `session/set_mode → dont_ask`.
3. **Model.** If `opts.model` differs from `currentModelId` → `session/set_model`.
4. **Prompt.** `session/prompt { sessionId, prompt:[{type:"text", text}] }` (+ image blocks
   from `opts.attachments` if present).
5. **Stream.** Handle `session/update` notifications → `opts.onStream`:
   - `agent_message_chunk`/`update_agent_message_text` → `{type:"text"}` (accumulate into
     `resultText`).
   - `agent_thought_chunk` → **dropped** from the answer (Grok lesson: never leak reasoning
     into the bubble); optionally surfaced as a `status` delta.
   - `tool_start` → `{type:"tool_use", toolName, toolId, input}`.
   - `tool_complete` → `{type:"tool_result", toolId, content}`.
   - `usage_update` → `{type:"context", content:String(used)}` and stash `size`/`used`.
   - `plan` → optional `status` delta (todos).
6. **Permission safety net.** Register a server-request handler: any
   `session/request_permission` → respond `allow_always`. (Under YOLO it won't fire.)
7. **Settle.** `session/prompt` resolves with `PromptResponse.stop_reason` → resolve
   `EngineResult { sessionId, result:resultText, contextTokens:used, error? }`. Backstop:
   per-turn watchdog timeout + process-`exit` handler so a dead process can't hang the
   promise (the codex/grok grandchild-pipe lesson, here applied to a crashed acp child).
8. **Resume id.** Return the Hermes `sessionId` as `EngineResult.sessionId`; the gateway
   stores it as `engineSessionId` and feeds it back next turn.

### 3.3 CLI Mode — `HermesInteractiveEngine`

`PtyViewEngine` backed by a `PtyLifecycleManager` (the same helper codex/grok-interactive use).
Spawns `hermes chat --cli --yolo --accept-hooks` (classic REPL — avoids alt-screen parsing
pain vs `--tui`). Provides `subscribeOutput` / `getScrollback` / `writeStdin` / `resizePty`
for the xterm tab. **v1: the xterm is a live terminal into Hermes; turns typed there are NOT
synced into the Cuttlefish message DB** (transcript-tail sync is Claude-only and out of scope here —
noted as a v2 follow-up). Registered in `ptyViewEngines["hermes"]`.

### 3.4 The Engine / Model / Effort picker

- **Engine:** appears automatically in the web picker once `"hermes"` is in `ENGINE_NAMES`
  and the `hermes` binary resolves on PATH (`engineAvailable`). The frontend list is fully
  data-driven from `GET /api/engines`; **no frontend code change** needed for the engine to
  appear.
- **Model:** sourced **live from Hermes**, not hardcoded. A `refreshHermesModels(config)`
  (mirroring `refreshGrokModels`) runs one cheap throwaway `initialize`+`session/new` against
  `hermes acp`, reads `models.availableModels`, and builds the registry entry
  (`buildHermesEntry`): `{ id: modelId, label: name, supportsEffort:false, contextWindow }`,
  default = `currentModelId`. Static fallback `knownHermesModels()` (the four
  `openai-codex:*` ids observed) when discovery fails. Mid-session model change →
  `session/set_model`. Called at boot, on config reload, and via `POST /api/engines/refresh`.
- **Effort:** `EFFORT_MECHANISM.hermes = "none"` → the effort control is **hidden** for
  Hermes (same as antigravity/pi). Hermes `modes` (edit-approval) are deliberately **not**
  surfaced as effort in v1.

### 3.5 Auto-approve (full autonomy)

Universal: spawn both the acp child and the PTY with env `HERMES_YOLO_MODE=1` +
`HERMES_ACCEPT_HOOKS=1`. ACP additionally: `set_mode → dont_ask` after `session/new`, and the
JSON-RPC client auto-answers `session/request_permission` with `allow_always`. PTY: `--yolo
--accept-hooks` flags. This makes org-driven Hermes turns non-blocking, consistent with how
claude/codex/grok run under bypass/--yolo.

## 4. File-by-file change list

**New files**
- `engines/hermes-protocol.ts`, `engines/hermes-jsonrpc.ts`, `engines/hermes-acp.ts`,
  `engines/hermes-interactive.ts`
- `shared/hermes-models.ts` (discovery + static fallback + effort consts)
- Tests: `engines/__tests__/hermes-protocol.test.ts`,
  `engines/__tests__/hermes-acp.test.ts`, `shared/__tests__/hermes-models.test.ts`

**Registry / types (TS will force most of these)**
- `shared/models.ts`: add `"hermes"` to `ENGINE_NAMES` + `ENGINE_BIN` (`hermes`) +
  `EFFORT_MECHANISM` (`none`) + `SYNTH_DEFAULTS` + `ENGINE_INSTALL_HINT`; add
  `refreshHermesModels()` + `buildHermesEntry()` branch in `buildRegistry`.
- `shared/types.ts`: add `"hermes"` to the `engines.default` union; add `engines.hermes?`
  config block `{ bin?; model?; }`.

**Wiring (requires gateway restart to load the adapter)**
- `gateway/server.ts`: import + instantiate `HermesAcpEngine` and `HermesInteractiveEngine`
  (+ a `PtyLifecycleManager` for the latter); `engines.set("hermes", hermesAcpEngine)`; add
  `hermes` to `ptyViewEngines`; `refreshHermesModels(cfg)` at boot; wire `killIdle`/`killAll`.
- `gateway/api.ts` + `cli/limits.ts`: call `refreshHermesModels` on config reload / limits.
- `shared/engine-limits.ts`: register hermes as `collectUnsupported` (no quota endpoint).

**Config + docs**
- `~/.cuttlefish/config.yaml`: add `engines.hermes: { bin: hermes, model: openai-codex:gpt-5.5 }`
  (optional — synthesizes if omitted).
- `cli/setup.ts`: add `engines.hermes` to the emitted default template + doctor binary check
  + `SetupEngine` union.
- `cli/migrate.ts`: `buildMigrateArgs` hermes case (if applicable).
- `talk/routes.ts` + valid-engine lists: include `hermes`.
- **README** (root + `packages/cuttlefish`): add Hermes to the engines table (what it is, install
  hint, Chat vs CLI mode, auto-approve note, metered-cost caveat).
- `docs/`: short `docs/engines-hermes.md` (or a section) — invocation contract, ACP event
  map, model/effort behavior, troubleshooting.
- New employee persona `~/.cuttlefish/org/<dept>/hermes-operator.yaml` with `engine: hermes`
  (opt-in usage), per the existing Codex `code-reviewer` precedent.

**No change needed:** session/cron engine resolution (`manager.ts`, `cron/runner.ts`),
session-selection validators (`session-patch.ts`), and the web engine/model pickers — all read
the registry / `GET /api/engines`.

## 5. Development lifecycle

1. **TDD the pure layer.** Write `hermes-protocol.test.ts` first (request builders;
   `session/update` → `StreamDelta` mapping incl. thought-dropping, usage→context,
   tool start/complete; `provider:model` encode/decode), then implement
   `hermes-protocol.ts`. Same for `hermes-models.test.ts` (parse `availableModels`, fallback).
2. **JSON-RPC client.** `hermes-jsonrpc.test.ts` with a mock stdio pair (line buffering,
   id→promise resolution, notification dispatch, server-request auto-answer), then implement.
3. **Engine.** `hermes-acp.test.ts` with a fake JSON-RPC client/process: new vs load, set_mode,
   set_model, prompt streaming, settle on stop_reason, watchdog/exit backstop, kill. Then
   `HermesAcpEngine`. Then `HermesInteractiveEngine` (PTY args + ready detection; reuse the
   grok-interactive test shape).
4. **Registry/config/wiring** per §4; `pnpm -C packages/cuttlefish test` + typecheck green.
5. **Live integration test** (real binary): a script that does `initialize` → `session/new` →
   one tiny `session/prompt` ("reply with the single word: ok"), asserts streamed `text`
   deltas + final result + a `usage_update`, then `session/load` + a second prompt to prove
   resume. (Costs a few tokens — acceptable.)
6. **Isolated gateway on :7788.** Launch a throwaway Cuttlefish instance
   (`PORT=7788`, isolated home) with the new build; create a session with `engine:"hermes"`;
   confirm: (a) engine + model picker list Hermes + its models, (b) a real prompt **streams
   live** in the web chat, (c) resume works across turns, (d) the **CLI Mode** xterm tab opens
   the `hermes` TUI.
7. **Chrome verification.** Use Claude-in-Chrome against `http://localhost:7788` to visually
   confirm streaming tokens appear incrementally (not one blob), the model dropdown shows the
   Hermes models, effort is hidden, and the CLI terminal renders. Capture a short GIF.
8. **Adversarial review.** Spawn the `code-reviewer` employee (Codex GPT-5.5 xhigh) on the
   diff; loop until crit/high (+ chosen medium) fixed.
9. **Docs/README** per §4; final typecheck + full test run.
10. **Report** to the maintainer with the :7788 evidence (GIF + notes); merge decision is theirs.

## 6. Risks & mitigations

- **Warm-process leak / restart recovery:** track children per Cuttlefish session; `killIdle`
  recycles idle acp processes; on gateway restart the process is gone → next turn re-spawns +
  `session/load` from persisted `engineSessionId`. Hard timeout + `exit` handler prevent hung
  `run()` promises.
- **Metered cost:** Hermes bills per token on its configured provider. The `hermes-operator`
  persona keeps it opt-in; README flags the cost difference from subscription engines.
- **Provider/model coupling:** available models depend on `~/.hermes` provider config; the
  registry is refreshed live so it always reflects reality, with a static fallback.
- **CLI-typed turns not in web DB (v1):** the xterm view is a live terminal only; syncing
  those turns into Cuttlefish's message store is a v2 follow-up (would need Hermes transcript-tail).
- **Version variance across machines:** the binary is PATH-resolved and capabilities are
  read from the live `initialize`/`session/new` handshake, so different Hermes versions adapt
  automatically. `initialize` negotiates `protocolVersion`; if a build ever predates ACP or
  fails the handshake, the engine reports unavailable rather than crashing. The static
  `knownHermesModels()` fallback is a last resort only when live discovery returns nothing.
- **ACP schema drift:** `hermes-protocol.ts` centralises all wire mapping so a future schema
  change is a one-file fix with failing unit tests to guide it; no version is pinned in code.

## 7. Out of scope (v1)

- Syncing CLI-Mode (xterm) turns into the Cuttlefish message DB.
- Mapping Cuttlefish's effort control to Hermes `modes`.
- Multi-provider model management inside Cuttlefish (we surface whatever Hermes's active provider
  offers).
- Hermes's own memory/skills curation (Cuttlefish owns org/product knowledge; Hermes owns its
  procedural memory) — left to Hermes.
