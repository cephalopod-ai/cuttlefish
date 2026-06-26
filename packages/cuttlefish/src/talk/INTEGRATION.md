# Cuttlefish Talk — Phase 2 integration brief (read me first)

Shared facts for all /talk workstreams. Contracts live in `protocol.ts` (backend)
and `packages/web/src/routes/talk/protocol.ts` (frontend) — code against those.

## AUTH SPIKE RESULT (verified ✅)
`@anthropic-ai/claude-agent-sdk` **v0.3.159** runs on the **Claude Code subscription, NO API key**.
Working `query()` options (proven):
```
model: "claude-sonnet-4-6"
systemPrompt: "<string>"            // a plain string REPLACES the default CC prompt
mcpServers: { talk }               // createSdkMcpServer({ name:"talk", version, tools:[tool(...)] })
allowedTools: ["mcp__talk__show_card", ...]   // tool names are mcp__<server>__<tool>
disallowedTools: ["Bash","Edit","Read","Write","WebFetch","WebSearch","Glob","Grep"]
permissionMode: "bypassPermissions"   // REQUIRED so headless tool calls aren't denied
maxTurns: 8
```
Stream: `for await (const msg of query(...))` → `msg.type==="assistant"` has
`msg.message.content[]` blocks (`{type:"text",text}` / `{type:"tool_use",name,input}`);
`msg.type==="result"` has `subtype`, `is_error`, `usage`. The SDK package must be
added to packages/cuttlefish deps. `tool(name, desc, zodRawShape, async handler)` returns
`{ content: [{ type:"text", text }] }`.

## HTTP routing  — packages/cuttlefish/src/gateway/api.ts → `handleApiRequest(req,res,context)`
Add routes by string match: `if (method==="POST" && pathname==="/api/talk/turn") {...}`.
Body helpers live in src/gateway/http-helpers.ts: `readJsonBody(req,res)` → `{ok,body}`;
`readBodyRaw(req)` → Buffer (raw audio). Response helpers in api.ts: `json(res, obj, status?)`;
`badRequest(res,msg)`. Register a single
`handleTalkApi(req,res,context)` dispatcher (in src/talk/routes.ts) and call it near the
STT routes. `context` exposes `emit(event,payload)` and `getConfig()`.

## WebSocket  — packages/cuttlefish/src/gateway/server.ts
`emit(event, payload)` broadcasts `{event,payload,ts}` to all web clients. Use the
event names from `protocol.ts` `TALK_EVENTS`. Frontend: `useGateway().subscribe((event,payload)=>...)`
receives ALL events (talk:* included). Do NOT rely on the legacy `events` array.

## TTS sidecar pattern  — mirror src/stt/stt.ts
STT lives in src/stt/stt.ts: `STT_MODELS_DIR = CUTTLEFISH_HOME/models/whisper`, model
download-on-first-use with progress, `transcribe()`. For Kokoro: use
`CUTTLEFISH_HOME/models/kokoro` + a Python venv + a long-running sidecar process
(spawn/health/restart), download onnx weights (~310MB) on first use emitting
`talk:tts:download:progress/complete`. Reuse STT endpoints for mic
(`/api/stt/transcribe`, `/api/stt/status`, `/api/stt/download`) — do NOT rebuild STT.

## Sessions / delegation  — src/sessions/registry.ts + gateway/api.ts + sessions/manager.ts
- `createSession(opts)` → Session (opts: engine,"source","connector",sessionKey,
  employee?, parentSessionId?, prompt, model?, effortLevel?).
- `getSession(id)`, `listSessions(filter?)`.
- Employees: `scanOrg()` → Map<name,Employee>; `findEmployee(name,registry)`.
- To actually RUN a delegated child turn, reuse the existing dispatch path the
  `/api/sessions` + `/api/sessions/:id/message` endpoints use (read api.ts
  `runWebSession` / manager `route`/`runSession`). The COO ("coo"/Jimbo) = a session
  with NO `employee` (default persona); a named employee = `employee:<name>`.
- DECISION: the /talk turn is NOT itself a gateway Session, so `notifyParentSession`
  injection won't reach us. delegate() POLLS the child Session's status/result
  (`getSession`) instead: sync → poll to terminal status, return result string;
  async → return immediately + a watcher emits `talk:task` updates as status changes.

## get_org_pulse  — read-only snapshot
From `listSessions()` filter active (status running|waiting), `scanOrg()` for employees,
count running-per-employee, and pending queue / boards for "awaiting approval". Return a
COMPACT object (counts + a few names), not raw dumps.

## Config + port
`loadConfig()` (src/shared/config.ts), `CONFIG_PATH = CUTTLEFISH_HOME/config.yaml`. Add an
optional `talk:` section (kokoro voice/model/sidecar port). Add `"talk"` to KNOWN_KEYS
in the PUT /api/config validator. **Run THIS worktree's gateway on GATEWAY_PORT=7788**;
the live daemon owns 8888 — never touch it.

## Definition of working
Real loop: mic → STT → POST /api/talk/turn → Agent-SDK Sonnet streams text (→ talk:say +
Kokoro audio) and calls tools (→ talk:card/talk:task) → avatar idle on talk:turn:done.
At least one real delegate→COO completes and is summarized aloud + shown as a tracker task.
