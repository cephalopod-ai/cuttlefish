# Hermes Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Hermes Agent (`hermes` CLI) as a first-class, version-agnostic Cuttlefish engine with real token streaming (ACP Chat Mode) and a live terminal view (PTY CLI Mode).

**Architecture:** Two engines mirroring the Codex/Grok dual pattern. `HermesAcpEngine` drives a warm, per-session `hermes acp` subprocess over ndjson JSON-RPC 2.0 (the Agent Client Protocol), streaming `text`/`tool_use`/`tool_result`/`context` deltas and resolving on `session/prompt`'s `stop_reason`. `HermesInteractiveEngine` spawns the real `hermes` TUI in `node-pty` for the dashboard xterm tab. Models are discovered live from the CLI's ACP handshake; effort is unsupported (Hermes has no effort knob).

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node `child_process` + `node-pty`, vitest. No new npm dependencies (hand-rolled ndjson JSON-RPC).

## Global Constraints

- **Version- & path-agnostic.** Resolve the binary via `resolveBin("hermes", opts.bin)`. Never hardcode a version or absolute path. Capabilities/models come from the live ACP handshake; `knownHermesModels()` is a last-resort static fallback only.
- **Full auto-approve.** Spawn every Hermes process with env `HERMES_YOLO_MODE=1` and `HERMES_ACCEPT_HOOKS=1`. ACP additionally: `session/set_mode → dont_ask`, and the JSON-RPC client auto-answers `session/request_permission` with `allow_always`.
- **Reasoning text never leaks** into the answer bubble (`agent_thought_chunk` dropped from `text`).
- **ESM imports** must use the `.js` suffix (e.g. `from "../shared/types.js"`).
- **Engine name** is the literal string `"hermes"` everywhere.
- **Test runner:** `npx vitest run <file>` from `packages/cuttlefish`. **Typecheck:** `npm -C packages/cuttlefish run typecheck`.
- **Commits:** no `Co-Authored-By` trailers (repo rule). Frequent, one per task minimum.
- **Branch:** `feat/hermes-engine` (already created).
- Wire mapping (reference snapshot, local v0.17.0): models are `provider:model` strings (`openai-codex:gpt-5.5`); `session/new` returns `{sessionId, models:{availableModels:[{modelId,name,description}],currentModelId}, modes, _meta}`; turn updates are `session/update` notifications with `update.sessionUpdate` ∈ `agent_message_chunk|agent_thought_chunk|tool_call|tool_call_update|plan|usage_update|available_commands_update` (older builds may also emit `agent_message_text`-style shapes — the mapper tolerates both).

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/cuttlefish/src/shared/hermes-models.ts` | Pure model parsing (`parseHermesModels`, `knownHermesModels`) + self-contained live discovery (`discoverHermesModels`) via a lightweight ACP handshake. Lives in `shared/` so `models.ts` can import it without a layer inversion. |
| `packages/cuttlefish/src/engines/hermes-protocol.ts` | PURE: JSON-RPC request builders + `session/update` → `StreamDelta` mappers + `provider:model` helpers. No I/O. |
| `packages/cuttlefish/src/engines/hermes-jsonrpc.ts` | Minimal ndjson JSON-RPC client over a child stdio pair: line-buffered reader, id→promise map, notification dispatch, server→client request handler. |
| `packages/cuttlefish/src/engines/hermes-acp.ts` | `HermesAcpEngine` (`InterruptibleEngine`): warm per-session `hermes acp` pool; `run()` orchestration; kill/isAlive/killAll/killIdle. |
| `packages/cuttlefish/src/engines/hermes-interactive.ts` | `HermesInteractiveEngine` (`PtyViewEngine`): `hermes` TUI in node-pty for the xterm view. |
| `packages/cuttlefish/src/shared/models.ts` | MODIFY: register `"hermes"` in `ENGINE_NAMES` + maps; add `refreshHermesModels` + `buildHermesEntry`. |
| `packages/cuttlefish/src/shared/types.ts` | MODIFY: add `"hermes"` to `engines.default` union + `engines.hermes?` block. |
| `packages/cuttlefish/src/gateway/server.ts` | MODIFY: instantiate + register both engines; boot discovery; killIdle/killAll. |
| `packages/cuttlefish/src/gateway/api.ts`, `cli/limits.ts` | MODIFY: `refreshHermesModels` on reload / limits. |
| `packages/cuttlefish/src/shared/engine-limits.ts` | MODIFY: register hermes as unsupported-quota. |
| `packages/cuttlefish/src/cli/setup.ts`, `talk/routes.ts` | MODIFY: default config template, doctor, SetupEngine union, talk valid-engine list. |
| `scripts/hermes-acp-smoke.mjs` | Live integration test script (real binary). |
| `README.md`, `docs/engines-hermes.md`, `~/.cuttlefish/org/platform/hermes-operator.yaml` | Docs + opt-in persona. |

---

## Task 1: Pure protocol module (`hermes-protocol.ts`)

**Files:**
- Create: `packages/cuttlefish/src/engines/hermes-protocol.ts`
- Test: `packages/cuttlefish/src/engines/__tests__/hermes-protocol.test.ts`

**Interfaces:**
- Produces:
  - `encodeModelChoice(provider: string | undefined, model: string): string` (→ `provider:model` or `model`)
  - `splitModelChoice(choiceId: string): { provider?: string; model: string }`
  - `rpcRequest(id: number, method: string, params: object): string` (ndjson line incl. trailing `\n`)
  - `rpcNotification(method: string, params: object): string`
  - `type HermesUpdate = { deltas: StreamDelta[]; contextTokens?: number; commands?: string[] }`
  - `mapSessionUpdate(update: Record<string, unknown>): HermesUpdate` (maps one `session/update.params.update`)
  - `extractPromptText(prompt: string): { type: "text"; text: string }[]`

- [ ] **Step 1: Write the failing test**

```ts
// packages/cuttlefish/src/engines/__tests__/hermes-protocol.test.ts
import { describe, it, expect } from "vitest";
import {
  encodeModelChoice, splitModelChoice, rpcRequest, mapSessionUpdate,
} from "../hermes-protocol.js";

describe("model choice encoding", () => {
  it("encodes provider:model and splits back", () => {
    expect(encodeModelChoice("openai-codex", "gpt-5.5")).toBe("openai-codex:gpt-5.5");
    expect(splitModelChoice("openai-codex:gpt-5.5")).toEqual({ provider: "openai-codex", model: "gpt-5.5" });
    expect(splitModelChoice("gpt-5.5")).toEqual({ provider: undefined, model: "gpt-5.5" });
  });
});

describe("rpcRequest", () => {
  it("produces a newline-terminated JSON-RPC 2.0 line", () => {
    const line = rpcRequest(1, "initialize", { protocolVersion: 1 });
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  });
});

describe("mapSessionUpdate", () => {
  it("maps an answer chunk to a text delta", () => {
    const r = mapSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } });
    expect(r.deltas).toEqual([{ type: "text", content: "hi" }]);
  });
  it("drops reasoning chunks from text (no leak)", () => {
    const r = mapSessionUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "secret reasoning" } });
    expect(r.deltas.filter((d) => d.type === "text")).toEqual([]);
  });
  it("maps usage_update to contextTokens", () => {
    const r = mapSessionUpdate({ sessionUpdate: "usage_update", size: 272000, used: 11833 });
    expect(r.contextTokens).toBe(11833);
    expect(r.deltas).toContainEqual({ type: "context", content: "11833" });
  });
  it("maps a tool_call to a tool_use delta", () => {
    const r = mapSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "t1", title: "bash", rawInput: { cmd: "ls" } });
    expect(r.deltas[0]).toMatchObject({ type: "tool_use", toolId: "t1", toolName: "bash" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cuttlefish && npx vitest run src/engines/__tests__/hermes-protocol.test.ts`
Expected: FAIL — `Cannot find module '../hermes-protocol.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/cuttlefish/src/engines/hermes-protocol.ts
import type { StreamDelta } from "../shared/types.js";

export function encodeModelChoice(provider: string | undefined, model: string): string {
  const m = (model || "").trim();
  const p = (provider || "").trim().toLowerCase();
  if (!m) return "";
  return p ? `${p}:${m}` : m;
}

export function splitModelChoice(choiceId: string): { provider?: string; model: string } {
  const idx = (choiceId || "").indexOf(":");
  if (idx <= 0) return { provider: undefined, model: choiceId };
  return { provider: choiceId.slice(0, idx), model: choiceId.slice(idx + 1) };
}

export function rpcRequest(id: number, method: string, params: object): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
}
export function rpcNotification(method: string, params: object): string {
  return JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
}

export interface HermesUpdate {
  deltas: StreamDelta[];
  contextTokens?: number;
  commands?: string[];
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (typeof c.text === "string") return c.text;
  }
  return "";
}

export function mapSessionUpdate(update: Record<string, unknown>): HermesUpdate {
  const kind = String(update.sessionUpdate ?? update.type ?? "");
  const deltas: StreamDelta[] = [];
  switch (kind) {
    case "agent_message_chunk":
    case "agent_message_text": {
      const t = textOf(update.content ?? update.text);
      if (t) deltas.push({ type: "text", content: t });
      return { deltas };
    }
    case "agent_thought_chunk":
    case "agent_thought_text":
      // Reasoning — never emit as answer text. (Optionally a status delta.)
      return { deltas };
    case "tool_call": {
      const id = String(update.toolCallId ?? update.toolId ?? "");
      const name = String(update.title ?? update.kind ?? update.name ?? "tool");
      const input = update.rawInput ?? update.input;
      deltas.push({
        type: "tool_use", content: name, toolId: id, toolName: name,
        input: input !== undefined ? JSON.stringify(input).slice(0, 200) : undefined,
      });
      return { deltas };
    }
    case "tool_call_update": {
      const id = String(update.toolCallId ?? update.toolId ?? "");
      const status = String(update.status ?? "");
      if (status === "completed" || status === "failed") {
        deltas.push({ type: "tool_result", content: status, toolId: id });
      }
      return { deltas };
    }
    case "usage_update": {
      const used = typeof update.used === "number" ? update.used : undefined;
      if (used !== undefined) deltas.push({ type: "context", content: String(used) });
      return { deltas, contextTokens: used };
    }
    case "available_commands_update": {
      const cmds = Array.isArray(update.availableCommands)
        ? (update.availableCommands as Array<{ name?: string }>).map((c) => String(c.name ?? "")).filter(Boolean)
        : [];
      return { deltas, commands: cmds };
    }
    default:
      return { deltas };
  }
}

export function extractPromptText(prompt: string): { type: "text"; text: string }[] {
  return [{ type: "text", text: prompt }];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cuttlefish && npx vitest run src/engines/__tests__/hermes-protocol.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/cuttlefish/src/engines/hermes-protocol.ts packages/cuttlefish/src/engines/__tests__/hermes-protocol.test.ts
git commit -m "feat(hermes): pure ACP protocol helpers (rpc builders + update→delta mappers)"
```

---

## Task 2: Model parsing + discovery (`hermes-models.ts`)

**Files:**
- Create: `packages/cuttlefish/src/shared/hermes-models.ts`
- Test: `packages/cuttlefish/src/shared/__tests__/hermes-models.test.ts`

**Interfaces:**
- Consumes: `ModelInfo` (`./types.js`), `encodeModelChoice` (`../engines/hermes-protocol.js`).
- Produces:
  - `interface HermesModelDiscovery { defaultModel?: string; models: ModelInfo[] }`
  - `parseHermesModels(newSessionResult: Record<string, unknown>): HermesModelDiscovery` — reads `models.availableModels` + `currentModelId`.
  - `knownHermesModels(pinned?: string): HermesModelDiscovery` — static fallback.
  - `discoverHermesModels(bin: string): Promise<HermesModelDiscovery>` — spawns `hermes acp`, performs a minimal `initialize`+`session/new` ndjson handshake (no model call), parses the result, kills the process. Never throws.
  - `HERMES_EFFORT_LEVELS: string[]` (empty — Hermes has no effort).

- [ ] **Step 1: Write the failing test**

```ts
// packages/cuttlefish/src/shared/__tests__/hermes-models.test.ts
import { describe, it, expect } from "vitest";
import { parseHermesModels, knownHermesModels } from "../hermes-models.js";

const NEW_SESSION = {
  sessionId: "abc",
  models: {
    currentModelId: "openai-codex:gpt-5.5",
    availableModels: [
      { modelId: "openai-codex:gpt-5.5", name: "gpt-5.5", description: "Provider: OpenAI Codex • current" },
      { modelId: "openai-codex:gpt-5.4", name: "gpt-5.4", description: "Provider: OpenAI Codex" },
    ],
  },
};

describe("parseHermesModels", () => {
  it("extracts models + default from a session/new result", () => {
    const r = parseHermesModels(NEW_SESSION);
    expect(r.defaultModel).toBe("openai-codex:gpt-5.5");
    expect(r.models.map((m) => m.id)).toEqual(["openai-codex:gpt-5.5", "openai-codex:gpt-5.4"]);
    expect(r.models[0]).toMatchObject({ id: "openai-codex:gpt-5.5", label: "gpt-5.5", supportsEffort: false, effortLevels: [] });
  });
  it("returns empty discovery when models block is absent", () => {
    expect(parseHermesModels({ sessionId: "x" })).toEqual({ defaultModel: undefined, models: [] });
  });
});

describe("knownHermesModels", () => {
  it("provides a non-empty static fallback and honors a pinned id", () => {
    const r = knownHermesModels("openai-codex:gpt-5.4");
    expect(r.defaultModel).toBe("openai-codex:gpt-5.4");
    expect(r.models.length).toBeGreaterThan(0);
    expect(r.models.every((m) => m.supportsEffort === false)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cuttlefish && npx vitest run src/shared/__tests__/hermes-models.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// packages/cuttlefish/src/shared/hermes-models.ts
import { spawn } from "node:child_process";
import type { ModelInfo } from "./types.js";
import { logger } from "./logger.js";

export const HERMES_EFFORT_LEVELS: string[] = [];

export interface HermesModelDiscovery {
  defaultModel?: string;
  models: ModelInfo[];
}

function hermesModelInfo(id: string, label?: string): ModelInfo {
  return { id, label: label || id, supportsEffort: false, effortLevels: [] };
}

/** Parse a `session/new` result payload into a model discovery. */
export function parseHermesModels(result: Record<string, unknown>): HermesModelDiscovery {
  const block = result?.models as Record<string, unknown> | undefined;
  const available = Array.isArray(block?.availableModels) ? (block!.availableModels as Array<Record<string, unknown>>) : [];
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const m of available) {
    const id = String(m.modelId ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push(hermesModelInfo(id, String(m.name ?? id)));
  }
  const defaultModel = block?.currentModelId ? String(block.currentModelId) : models[0]?.id;
  return { defaultModel, models };
}

/** Static last-resort catalog (only used when live discovery yields nothing). */
export function knownHermesModels(pinned?: string): HermesModelDiscovery {
  const ids = ["openai-codex:gpt-5.5", "openai-codex:gpt-5.4"];
  if (pinned && !ids.includes(pinned)) ids.unshift(pinned);
  return { defaultModel: pinned || ids[0], models: ids.map((id) => hermesModelInfo(id, id.includes(":") ? id.split(":")[1] : id)) };
}

/** Live discovery: spawn `hermes acp`, do a no-cost initialize+session/new handshake, read models, kill. */
export async function discoverHermesModels(bin: string): Promise<HermesModelDiscovery> {
  return new Promise<HermesModelDiscovery>((resolve) => {
    let done = false;
    const finish = (d: HermesModelDiscovery) => { if (!done) { done = true; try { proc.kill("SIGTERM"); } catch {} resolve(d); } };
    let buf = "";
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(bin, ["acp"], {
        stdio: ["pipe", "pipe", "ignore"],
        env: { ...process.env, HERMES_YOLO_MODE: "1", HERMES_ACCEPT_HOOKS: "1" },
      });
    } catch (e) {
      logger.warn(`hermes acp discovery spawn failed: ${e instanceof Error ? e.message : e}`);
      return resolve({ models: [] });
    }
    const timer = setTimeout(() => finish({ models: [] }), 20000);
    proc.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && msg.result) {
          proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } }) + "\n");
        } else if (msg.id === 2 && msg.result) {
          clearTimeout(timer);
          finish(parseHermesModels(msg.result as Record<string, unknown>));
        }
      }
    });
    proc.on("error", () => { clearTimeout(timer); finish({ models: [] }); });
    proc.on("close", () => { clearTimeout(timer); finish({ models: [] }); });
    proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } }) + "\n");
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cuttlefish && npx vitest run src/shared/__tests__/hermes-models.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cuttlefish/src/shared/hermes-models.ts packages/cuttlefish/src/shared/__tests__/hermes-models.test.ts
git commit -m "feat(hermes): model parsing + live ACP discovery with static fallback"
```

---

## Task 3: ndjson JSON-RPC client (`hermes-jsonrpc.ts`)

**Files:**
- Create: `packages/cuttlefish/src/engines/hermes-jsonrpc.ts`
- Test: `packages/cuttlefish/src/engines/__tests__/hermes-jsonrpc.test.ts`

**Interfaces:**
- Consumes: a `Writable` stdin + `Readable` stdout (so tests inject `stream.PassThrough`).
- Produces:
  - `class HermesRpc` with:
    - `constructor(stdin: Writable, stdout: Readable)`
    - `request<T = unknown>(method: string, params: object): Promise<T>` (resolves on matching `id`)
    - `notify(method: string, params: object): void`
    - `onNotification(cb: (method: string, params: Record<string, unknown>) => void): void`
    - `onServerRequest(cb: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>): void` (its return value is sent back as the JSON-RPC result for that id)
    - `rejectAll(err: Error): void` (called on process exit to fail pending requests)

- [ ] **Step 1: Write the failing test**

```ts
// packages/cuttlefish/src/engines/__tests__/hermes-jsonrpc.test.ts
import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { HermesRpc } from "../hermes-jsonrpc.js";

function pair() {
  const toServer = new PassThrough(); // client stdin  (we write)
  const fromServer = new PassThrough(); // client stdout (we read)
  const rpc = new HermesRpc(toServer, fromServer);
  return { rpc, toServer, fromServer };
}

describe("HermesRpc", () => {
  it("resolves a request when a matching id result arrives", async () => {
    const { rpc, toServer, fromServer } = pair();
    const p = rpc.request("initialize", { protocolVersion: 1 });
    const sent = JSON.parse((toServer.read() as Buffer).toString());
    expect(sent).toMatchObject({ jsonrpc: "2.0", method: "initialize", id: sent.id });
    fromServer.write(JSON.stringify({ jsonrpc: "2.0", id: sent.id, result: { ok: true } }) + "\n");
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("dispatches notifications", async () => {
    const { rpc, fromServer } = pair();
    const seen: any[] = [];
    rpc.onNotification((m, params) => seen.push([m, params]));
    fromServer.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { x: 1 } }) + "\n");
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual([["session/update", { x: 1 }]]);
  });

  it("auto-answers a server→client request via onServerRequest", async () => {
    const { rpc, toServer, fromServer } = pair();
    rpc.onServerRequest(() => ({ outcome: { outcome: "selected", optionId: "allow_always" } }));
    fromServer.write(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 5));
    const reply = JSON.parse((toServer.read() as Buffer).toString());
    expect(reply).toMatchObject({ jsonrpc: "2.0", id: 99, result: { outcome: { optionId: "allow_always" } } });
  });

  it("rejectAll fails pending requests", async () => {
    const { rpc } = pair();
    const p = rpc.request("x", {});
    rpc.rejectAll(new Error("dead"));
    await expect(p).rejects.toThrow("dead");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cuttlefish && npx vitest run src/engines/__tests__/hermes-jsonrpc.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// packages/cuttlefish/src/engines/hermes-jsonrpc.ts
import type { Writable, Readable } from "node:stream";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class HermesRpc {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private notifyCb?: (method: string, params: Record<string, unknown>) => void;
  private serverReqCb?: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;
  private buf = "";

  constructor(private stdin: Writable, stdout: Readable) {
    stdout.on("data", (d: Buffer) => this.onData(d));
  }

  request<T = unknown>(method: string, params: object): Promise<T> {
    const id = this.nextId++;
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    const p = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
    this.stdin.write(line);
    return p;
  }

  notify(method: string, params: object): void {
    this.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  onNotification(cb: (method: string, params: Record<string, unknown>) => void): void { this.notifyCb = cb; }
  onServerRequest(cb: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>): void { this.serverReqCb = cb; }

  rejectAll(err: Error): void {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  private onData(d: Buffer): void {
    this.buf += d.toString();
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line); } catch { continue; }
      this.handle(msg);
    }
  }

  private async handle(msg: Record<string, unknown>): Promise<void> {
    const id = msg.id as number | undefined;
    if (typeof id === "number" && (("result" in msg) || ("error" in msg))) {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if ("error" in msg && msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (typeof id === "number" && typeof msg.method === "string") {
      // server→client request: answer it
      let result: unknown = null;
      try { result = this.serverReqCb ? await this.serverReqCb(msg.method, (msg.params ?? {}) as Record<string, unknown>) : null; }
      catch { result = null; }
      this.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
      return;
    }
    if (typeof msg.method === "string") {
      this.notifyCb?.(msg.method, (msg.params ?? {}) as Record<string, unknown>);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cuttlefish && npx vitest run src/engines/__tests__/hermes-jsonrpc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cuttlefish/src/engines/hermes-jsonrpc.ts packages/cuttlefish/src/engines/__tests__/hermes-jsonrpc.test.ts
git commit -m "feat(hermes): minimal ndjson JSON-RPC client (requests, notifications, server-req auto-answer)"
```

---

## Task 4: `HermesAcpEngine` (Chat Mode)

**Files:**
- Create: `packages/cuttlefish/src/engines/hermes-acp.ts`
- Test: `packages/cuttlefish/src/engines/__tests__/hermes-acp.test.ts`

**Interfaces:**
- Consumes: `HermesRpc` (`./hermes-jsonrpc.js`), `mapSessionUpdate`/`extractPromptText` (`./hermes-protocol.js`), `resolveBin` (`../shared/resolve-bin.js`), `InterruptibleEngine`/`EngineRunOpts`/`EngineResult` (`../shared/types.js`).
- Produces: `class HermesAcpEngine implements InterruptibleEngine` with `name = "hermes"`, `run`, `kill`, `isAlive`, `killAll`, `killIdle` (no-op). Plus an injectable seam for tests: a protected `spawnProc(bin, cwd)` returning `{ rpc, kill, isAlive, onExit }` so the test can substitute a fake instead of a real process.

**Design notes (implement exactly):**
- Maintain `Map<cuttlefishSessionId, HermesProc>` where `HermesProc = { rpc, killProc, alive, hermesSessionId?, initialized: Promise<void> }`.
- `run(opts)`:
  1. `bin = resolveBin("hermes", opts.bin)`. Get-or-spawn the per-session proc (env `HERMES_YOLO_MODE=1`, `HERMES_ACCEPT_HOOKS=1`, cwd `opts.cwd`). On first spawn: `await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: {} })`, register `rpc.onServerRequest(() => ({ outcome: { outcome: "selected", optionId: "allow_always" } }))`.
  2. Session: if `opts.resumeSessionId` and we don't yet hold a live hermesSessionId → `rpc.request("session/load", { sessionId: opts.resumeSessionId, cwd, mcpServers: [] })`; else `const ns = await rpc.request("session/new", { cwd, mcpServers: [] })` and store `hermesSessionId = ns.sessionId`. After new/load: `rpc.request("session/set_mode", { sessionId, modeId: "dont_ask" }).catch(()=>{})`.
  3. Model: if `opts.model && opts.model !== currentModelId` → `rpc.request("session/set_model", { sessionId, modelId: opts.model }).catch(()=>{})`.
  4. Register a per-turn notification handler: `rpc.onNotification((m, params) => { if (m==="session/update" && params.sessionId===hermesSessionId) { const u = mapSessionUpdate(params.update); for (const d of u.deltas){ if (d.type==="text") resultText += d.content; opts.onStream?.(d);} if (u.contextTokens!=null) lastContext = u.contextTokens; } })`.
  5. `const res = await rpc.request("session/prompt", { sessionId, prompt: extractPromptText(opts.prompt) })` with a hard watchdog timer and a process-exit rejection (`rpc.rejectAll`). `stop_reason` of `refusal`/`cancelled` → set `error` if no text.
  6. Resolve `{ sessionId: hermesSessionId, result: resultText, contextTokens: lastContext, error }`.
- `kill(id)`: kill the proc, mark `alive=false`, delete from map. `isAlive(id)`: map has it and alive. `killAll()`: kill every proc. `killIdle()`: no-op (warm processes are session-scoped, not a shared idle pool; recycle happens via kill on org reload).

- [ ] **Step 1: Write the failing test** (fake proc seam — no real binary)

```ts
// packages/cuttlefish/src/engines/__tests__/hermes-acp.test.ts
import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { HermesRpc } from "../hermes-jsonrpc.js";
import { HermesAcpEngine } from "../hermes-acp.js";

// A fake Hermes server: answers initialize/session.new/set_mode/prompt and
// streams one answer chunk + a usage_update before the prompt result.
function fakeServer() {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const rpc = new HermesRpc(toServer, fromServer);
  toServer.on("data", (b: Buffer) => {
    for (const line of b.toString().split("\n")) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const reply = (result: unknown) => fromServer.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
      const note = (params: unknown) => fromServer.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params }) + "\n");
      if (msg.method === "initialize") reply({ protocolVersion: 1 });
      else if (msg.method === "session/new") reply({ sessionId: "S1", models: { currentModelId: "openai-codex:gpt-5.5", availableModels: [] } });
      else if (msg.method === "session/set_mode") reply({});
      else if (msg.method === "session/prompt") {
        note({ sessionId: "S1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } });
        note({ sessionId: "S1", update: { sessionUpdate: "usage_update", size: 1000, used: 42 } });
        reply({ stopReason: "end_turn" });
      }
    }
  });
  return rpc;
}

class TestEngine extends HermesAcpEngine {
  protected spawnProc() {
    const rpc = fakeServer();
    return { rpc, killProc: () => {}, isAliveProc: () => true, onExit: (_cb: () => void) => {} };
  }
}

describe("HermesAcpEngine.run", () => {
  it("streams text + context and returns the hermes session id", async () => {
    const eng = new TestEngine();
    const deltas: any[] = [];
    const r = await eng.run({ prompt: "hi", cwd: "/tmp", sessionId: "cuttlefish-1", onStream: (d) => deltas.push(d) });
    expect(r.sessionId).toBe("S1");
    expect(r.result).toBe("ok");
    expect(r.contextTokens).toBe(42);
    expect(deltas).toContainEqual({ type: "text", content: "ok" });
    expect(eng.isAlive("cuttlefish-1")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cuttlefish && npx vitest run src/engines/__tests__/hermes-acp.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Implement `packages/cuttlefish/src/engines/hermes-acp.ts` exactly per the Design notes above. Key structure:

```ts
import { spawn, type ChildProcess } from "node:child_process";
import type { InterruptibleEngine, EngineRunOpts, EngineResult } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { HermesRpc } from "./hermes-jsonrpc.js";
import { mapSessionUpdate, extractPromptText } from "./hermes-protocol.js";

const TURN_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
const ALLOW_ALWAYS = { outcome: { outcome: "selected", optionId: "allow_always" } };

interface ProcHandle { rpc: HermesRpc; killProc: () => void; isAliveProc: () => boolean; onExit: (cb: () => void) => void; }
interface HermesProc { handle: ProcHandle; alive: boolean; hermesSessionId?: string; currentModelId?: string; initialized: Promise<void>; }

export class HermesAcpEngine implements InterruptibleEngine {
  name = "hermes" as const;
  private procs = new Map<string, HermesProc>();

  /** Test seam — overridden in unit tests to inject a fake server. */
  protected spawnProc(bin: string, cwd: string): ProcHandle {
    const child: ChildProcess = spawn(bin, ["acp"], {
      stdio: ["pipe", "pipe", "ignore"],
      cwd,
      detached: process.platform !== "win32",
      env: { ...process.env, HERMES_YOLO_MODE: "1", HERMES_ACCEPT_HOOKS: "1" },
    });
    const rpc = new HermesRpc(child.stdin!, child.stdout!);
    return {
      rpc,
      killProc: () => { try { process.kill(-child.pid!, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} } },
      isAliveProc: () => child.exitCode === null && !child.killed,
      onExit: (cb) => child.on("exit", cb),
    };
  }

  private getOrSpawn(cuttlefishId: string, bin: string, cwd: string): HermesProc {
    let p = this.procs.get(cuttlefishId);
    if (p && p.alive) return p;
    const handle = this.spawnProc(bin, cwd);
    handle.rpc.onServerRequest(() => ALLOW_ALWAYS);
    const entry: HermesProc = {
      handle, alive: true,
      initialized: handle.rpc.request("initialize", { protocolVersion: 1, clientCapabilities: {} }).then(() => {}),
    };
    handle.onExit(() => { entry.alive = false; handle.rpc.rejectAll(new Error("hermes acp exited")); });
    this.procs.set(cuttlefishId, entry);
    return entry;
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const cuttlefishId = opts.sessionId || opts.resumeSessionId || "default";
    const bin = resolveBin("hermes", opts.bin);
    const p = this.getOrSpawn(cuttlefishId, bin, opts.cwd);
    const { rpc } = p.handle;
    await p.initialized;

    // session/new or session/load
    if (!p.hermesSessionId) {
      if (opts.resumeSessionId) {
        await rpc.request("session/load", { sessionId: opts.resumeSessionId, cwd: opts.cwd, mcpServers: [] }).catch(() => {});
        p.hermesSessionId = opts.resumeSessionId;
      } else {
        const ns = await rpc.request<Record<string, any>>("session/new", { cwd: opts.cwd, mcpServers: [] });
        p.hermesSessionId = String(ns.sessionId);
        p.currentModelId = ns.models?.currentModelId ? String(ns.models.currentModelId) : undefined;
      }
      await rpc.request("session/set_mode", { sessionId: p.hermesSessionId, modeId: "dont_ask" }).catch(() => {});
    }
    if (opts.model && opts.model !== p.currentModelId) {
      await rpc.request("session/set_model", { sessionId: p.hermesSessionId, modelId: opts.model }).catch(() => {});
      p.currentModelId = opts.model;
    }

    let resultText = "";
    let lastContext: number | undefined;
    const onNote = (m: string, params: Record<string, any>) => {
      if (m !== "session/update" || params.sessionId !== p.hermesSessionId) return;
      const u = mapSessionUpdate(params.update ?? {});
      for (const d of u.deltas) { if (d.type === "text") resultText += d.content; opts.onStream?.(d); }
      if (u.contextTokens != null) lastContext = u.contextTokens;
    };
    rpc.onNotification(onNote);

    let watchdog: NodeJS.Timeout | undefined;
    try {
      const res = await Promise.race([
        rpc.request<Record<string, any>>("session/prompt", { sessionId: p.hermesSessionId, prompt: extractPromptText(opts.prompt) }),
        new Promise<never>((_, rej) => { watchdog = setTimeout(() => rej(new Error("hermes turn timeout")), TURN_TIMEOUT_MS); watchdog.unref?.(); }),
      ]);
      const stop = String(res.stopReason ?? res.stop_reason ?? "");
      const error = (!resultText && (stop === "refusal" || stop === "cancelled")) ? `Hermes turn ended: ${stop}` : undefined;
      return { sessionId: p.hermesSessionId!, result: resultText, contextTokens: lastContext, error };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { sessionId: p.hermesSessionId || "", result: resultText, contextTokens: lastContext, error: resultText ? undefined : msg };
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
  }

  kill(sessionId: string): void { const p = this.procs.get(sessionId); if (p) { p.alive = false; p.handle.killProc(); this.procs.delete(sessionId); } }
  isAlive(sessionId: string): boolean { const p = this.procs.get(sessionId); return !!p && p.alive && p.handle.isAliveProc(); }
  killAll(): void { for (const p of this.procs.values()) { p.alive = false; try { p.handle.killProc(); } catch {} } this.procs.clear(); }
  killIdle(): void { /* no shared idle pool; per-session procs recycle via kill on org reload */ }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cuttlefish && npx vitest run src/engines/__tests__/hermes-acp.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
cd packages/cuttlefish && npm run typecheck && cd ../..
git add packages/cuttlefish/src/engines/hermes-acp.ts packages/cuttlefish/src/engines/__tests__/hermes-acp.test.ts
git commit -m "feat(hermes): HermesAcpEngine — warm per-session ACP process, streaming run()"
```

---

## Task 5: Registry + types wiring

**Files:**
- Modify: `packages/cuttlefish/src/shared/models.ts` (lines 34, 38-44, 46-52, 57-65, 86-92, 100-103, ~205-215; add `refreshHermesModels` + `buildHermesEntry`)
- Modify: `packages/cuttlefish/src/shared/types.ts:417`-region (no new mechanism), `:546` union, `:561` config block
- Test: `packages/cuttlefish/src/shared/__tests__/models.test.ts` (extend existing)

**Interfaces:**
- Produces: `refreshHermesModels(config: CuttlefishConfig): Promise<void>`; registry entry under key `"hermes"` with `effortMechanism: "none"`.

- [ ] **Step 1: Add the failing test** (append to existing models test or new file)

```ts
// packages/cuttlefish/src/shared/__tests__/hermes-registry.test.ts
import { describe, it, expect } from "vitest";
import { buildRegistry } from "../models.js";

const cfg: any = {
  engines: { default: "claude", claude: { bin: "claude", model: "opus" }, hermes: { bin: "hermes", model: "openai-codex:gpt-5.5" } },
};

describe("hermes registry entry", () => {
  it("exists with effortMechanism none and a default model", () => {
    const reg = buildRegistry(cfg);
    expect(reg.hermes).toBeDefined();
    expect(reg.hermes.effortMechanism).toBe("none");
    expect(reg.hermes.defaultModel).toBeTruthy();
    expect(reg.hermes.models.every((m) => m.supportsEffort === false)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/cuttlefish && npx vitest run src/shared/__tests__/hermes-registry.test.ts`
Expected: FAIL — `reg.hermes` is undefined (engine not registered).

- [ ] **Step 3: Edit `models.ts`**

3a. Add the import near the top (after the grok-models import):
```ts
import { discoverHermesModels, knownHermesModels, HERMES_EFFORT_LEVELS, type HermesModelDiscovery } from "./hermes-models.js";
```
3b. `ENGINE_NAMES` (line 34): add `"hermes"`:
```ts
const ENGINE_NAMES = ["claude", "codex", "antigravity", "grok", "pi", "hermes"] as const;
```
3c. `ENGINE_BIN` (line 38): add `hermes: "hermes",`.
3d. `EFFORT_MECHANISM` (line 46): add `hermes: "none",`.
3e. `SYNTH_DEFAULTS` (line 57): add `hermes: { supportsEffort: false, effortLevels: HERMES_EFFORT_LEVELS, fallbackModel: "openai-codex:gpt-5.5" },`.
3f. `ENGINE_INSTALL_HINT` (line 86): add `hermes: "install the Hermes CLI: curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",`.
3g. Add a discovered-models snapshot (near line 103):
```ts
let discoveredHermesModels: HermesModelDiscovery | null = null;
```
3h. Add `refreshHermesModels` (after `refreshGrokModels`, ~line 149):
```ts
export async function refreshHermesModels(config: CuttlefishConfig): Promise<void> {
  if (!engineAvailable(config, "hermes")) { discoveredHermesModels = null; invalidateModelRegistry(); return; }
  try {
    const bin = resolveBin("hermes", engineBinOverride(config, "hermes"));
    discoveredHermesModels = await discoverHermesModels(bin);
    logger.info(`Hermes model discovery: ${discoveredHermesModels.models.length} model(s)`);
  } catch (err) {
    logger.warn(`Hermes model discovery failed: ${err instanceof Error ? err.message : err}`);
    discoveredHermesModels = null;
  } finally { invalidateModelRegistry(); }
}
```
3i. In `buildRegistry` (after the grok branch, ~line 208) add:
```ts
    if (name === "hermes") { registry[name] = buildHermesEntry(config, block?.hermes, synthesized[name], available); continue; }
```
3j. Add `buildHermesEntry` (after `buildGrokEntry`):
```ts
function buildHermesEntry(
  config: CuttlefishConfig,
  hermesBlock: EngineModelsConfig | undefined,
  synthEntry: EngineRegistryEntry,
  available: boolean,
): EngineRegistryEntry {
  const pinned = config.engines.hermes?.model;
  if (discoveredHermesModels && discoveredHermesModels.models.length > 0) {
    const models = discoveredHermesModels.models;
    const valid = (id?: string) => (id && models.some((m) => m.id === id) ? id : undefined);
    const defaultModel = valid(pinned) ?? valid(discoveredHermesModels.defaultModel) ?? models[0].id;
    return { name: "hermes", available, defaultModel, effortMechanism: "none", models };
  }
  if (hermesBlock) return fromEngineModelsConfig("hermes", hermesBlock, available, pinned);
  const known = knownHermesModels(pinned);
  return { name: "hermes", available, defaultModel: known.defaultModel || synthEntry.defaultModel, effortMechanism: "none", models: known.models };
}
```

- [ ] **Step 4: Edit `types.ts`**

4a. Line 546 — add `"hermes"` to the union:
```ts
    default: "claude" | "codex" | "antigravity" | "grok" | "pi" | "hermes";
```
4b. After line 561 (`pi?: …`) add:
```ts
    /** Hermes (`hermes` CLI) engine. `bin` optional — PATH-resolved. No effort. */
    hermes?: { bin?: string; model?: string };
```

- [ ] **Step 5: Run to verify it passes + typecheck**

Run: `cd packages/cuttlefish && npx vitest run src/shared/__tests__/hermes-registry.test.ts && npm run typecheck`
Expected: PASS, typecheck clean (no remaining `Record<EngineName,…>` errors).

- [ ] **Step 6: Commit**

```bash
git add packages/cuttlefish/src/shared/models.ts packages/cuttlefish/src/shared/types.ts packages/cuttlefish/src/shared/__tests__/hermes-registry.test.ts
git commit -m "feat(hermes): register engine in model registry + config types (effort: none)"
```

---

## Task 6: `HermesInteractiveEngine` (CLI Mode / PTY view)

**Files:**
- Create: `packages/cuttlefish/src/engines/hermes-interactive.ts`
- Test: `packages/cuttlefish/src/engines/__tests__/hermes-interactive.test.ts`

**Interfaces:**
- Consumes: `PtyLifecycleManager` (`./pty-lifecycle.js`), `PtyViewEngine`/`PtyIdleSpawnOpts` (`./pty-view-engine.js`), `resolveBin`.
- Produces:
  - `buildHermesInteractiveArgs(): string[]` (pure, exported for test) → `["chat", "--cli", "--yolo", "--accept-hooks"]`.
  - `isHermesTuiReady(output: string): boolean` (pure) → true when the REPL prompt is visible.
  - `class HermesInteractiveEngine implements InterruptibleEngine, PtyViewEngine` (constructed with a `PtyLifecycleManager`). For v1 the engine backs the xterm **view only**; `run()` returns a clear "use Chat Mode" error so it is never accidentally used for work turns (work turns go through `HermesAcpEngine`).

**Note:** Model the PTY plumbing on `grok-interactive.ts` (same `PtyLifecycleManager`, `PtyStreamManager`, `subscribeOutput`/`getScrollback`/`writeStdin`/`resizePty`). v1 does **not** sync CLI-typed turns into the Cuttlefish DB (out of scope per spec).

- [ ] **Step 1: Write the failing test** (pure helpers only — PTY I/O is covered by the live :7788 check in Task 9)

```ts
// packages/cuttlefish/src/engines/__tests__/hermes-interactive.test.ts
import { describe, it, expect } from "vitest";
import { buildHermesInteractiveArgs, isHermesTuiReady } from "../hermes-interactive.js";

describe("hermes interactive args", () => {
  it("uses classic REPL with full auto-approve", () => {
    expect(buildHermesInteractiveArgs()).toEqual(["chat", "--cli", "--yolo", "--accept-hooks"]);
  });
});

describe("isHermesTuiReady", () => {
  it("detects the REPL prompt", () => {
    expect(isHermesTuiReady("…\nhermes › ")).toBe(true);
    expect(isHermesTuiReady("loading…")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/cuttlefish && npx vitest run src/engines/__tests__/hermes-interactive.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `hermes-interactive.ts`

Mirror `grok-interactive.ts` structure (PtyLifecycleManager-backed `PtyViewEngine`). Minimum for the test + view:
```ts
import type { InterruptibleEngine, EngineRunOpts, EngineResult } from "../shared/types.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { PtyLifecycleManager } from "./pty-lifecycle.js";
import type { PtyControlEvent, PtyIdleSpawnOpts, PtyViewEngine } from "./pty-view-engine.js";

export function buildHermesInteractiveArgs(): string[] {
  return ["chat", "--cli", "--yolo", "--accept-hooks"];
}
export function isHermesTuiReady(output: string): boolean {
  return /hermes\s*[›>❯]/i.test(output);
}

export class HermesInteractiveEngine implements InterruptibleEngine, PtyViewEngine {
  name = "hermes" as const;
  constructor(private lifecycle: PtyLifecycleManager) {}
  async run(_opts: EngineRunOpts): Promise<EngineResult> {
    return { sessionId: "", result: "", error: "Hermes CLI Mode is view-only; work turns run on Hermes Chat Mode (ACP)." };
  }
  // PtyViewEngine — delegate to lifecycle/PtyStreamManager exactly as grok-interactive.ts does.
  // (Implement hasWarmPty/ensureIdleSpawn/subscribeOutput/getScrollback/setViewing/writeStdin/
  //  writeRaw/resizePty by copying grok-interactive's bodies, swapping spawn args for
  //  buildHermesInteractiveArgs() and the ready check for isHermesTuiReady, and dropping the
  //  transcript-tail turn capture — v1 view does not sync CLI-typed turns.)
  kill(): void {}
  isAlive(): boolean { return false; }
  killAll(): void { this.lifecycle.killAll?.(); }
  killIdle(): void { this.lifecycle.killIdle?.(); }
}
```
Then flesh out the `PtyViewEngine` methods by copying the corresponding bodies from `grok-interactive.ts` (the view/scrollback/stdin/resize plumbing is engine-agnostic), substituting `buildHermesInteractiveArgs()` for the spawn args and `isHermesTuiReady` for readiness, and removing the transcript-tail/turn-completion machinery.

- [ ] **Step 4: Run to verify it passes + typecheck**

Run: `cd packages/cuttlefish && npx vitest run src/engines/__tests__/hermes-interactive.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cuttlefish/src/engines/hermes-interactive.ts packages/cuttlefish/src/engines/__tests__/hermes-interactive.test.ts
git commit -m "feat(hermes): HermesInteractiveEngine — hermes TUI in node-pty for CLI Mode view"
```

---

## Task 7: Gateway wiring (`server.ts`, `api.ts`, `cli/limits.ts`, `engine-limits.ts`)

**Files:**
- Modify: `packages/cuttlefish/src/gateway/server.ts` (imports ~21; instantiation ~325-335; `engines.set` ~345; `ptyViewEngines` ~349-354; boot discovery near other `refresh*Models`; killIdle/killAll wiring)
- Modify: `packages/cuttlefish/src/gateway/api.ts` (config-reload `refresh*Models` call site)
- Modify: `packages/cuttlefish/src/cli/limits.ts` (limits path `refresh*Models`)
- Modify: `packages/cuttlefish/src/shared/engine-limits.ts` (register hermes unsupported)

**Interfaces:**
- Consumes: `HermesAcpEngine`, `HermesInteractiveEngine`, `refreshHermesModels`.

- [ ] **Step 1: Edit `server.ts`**

1a. Imports (with the other engine imports near line 21):
```ts
import { HermesAcpEngine } from "../engines/hermes-acp.js";
import { HermesInteractiveEngine } from "../engines/hermes-interactive.js";
```
1b. Import `refreshHermesModels` from `../shared/models.js` (add to the existing models import list).
1c. Instantiate (after the grok block ~line 330):
```ts
  hermesLifecycle = new PtyLifecycleManager({
    maxLivePtys: claudeCfg.maxLivePtys!,
    onAdopt: () => refreshPtyPids(),
    onCleanup: () => refreshPtyPids(),
  });
  const hermesInteractiveEngine = new HermesInteractiveEngine(hermesLifecycle);
  const hermesEngine = new HermesAcpEngine();
```
(Declare `hermesLifecycle` alongside the other `*Lifecycle` module-scope vars — match how `grokLifecycle` is declared.)
1d. Register (after `engines.set("pi", piEngine);` line 345):
```ts
  engines.set("hermes", hermesEngine);
```
1e. Add to `ptyViewEngines` (after `grok:` line 353):
```ts
    hermes: hermesInteractiveEngine,
```
1f. Boot discovery — next to the other `refresh*Models(cfg)` boot calls, add `refreshHermesModels(currentConfig)` (fire-and-forget, matching grok/pi).
1g. Ensure shutdown calls `hermesEngine.killAll()` and org-reload calls `hermesEngine.killIdle()` wherever the other engines' `killAll`/`killIdle` are invoked (search `grokEngine.killAll`/`killIdle` and add the hermes equivalents alongside).

- [ ] **Step 2: Edit `api.ts` + `cli/limits.ts`**

Find each existing `refreshGrokModels(<cfg>)` call and add `refreshHermesModels(<cfg>)` immediately after it (import `refreshHermesModels` in each file). These are the config-reload (api.ts) and limits (limits.ts) refresh sites.

- [ ] **Step 3: Edit `engine-limits.ts`**

Register `hermes` in the same place `grok` is registered as `collectUnsupported` (no quota endpoint). Search for `grok` in `engine-limits.ts` and add a parallel `hermes` entry.

- [ ] **Step 4: Typecheck + build**

Run: `cd packages/cuttlefish && npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cuttlefish/src/gateway/server.ts packages/cuttlefish/src/gateway/api.ts packages/cuttlefish/src/cli/limits.ts packages/cuttlefish/src/shared/engine-limits.ts
git commit -m "feat(hermes): wire engines into gateway (register, ptyView, boot discovery, limits)"
```

---

## Task 8: Config template, setup doctor, talk routes

**Files:**
- Modify: `packages/cuttlefish/src/cli/setup.ts` (default config template `engines.hermes`; doctor binary check; `SetupEngine` union)
- Modify: `packages/cuttlefish/src/talk/routes.ts` (valid-engine list)
- Modify: `~/.cuttlefish/config.yaml` (live config — add `engines.hermes`)

- [ ] **Step 1: `setup.ts`**

1a. In the emitted default config template (search the `engines:` block, ~line 255), add under the engines map:
```yaml
    hermes:
      bin: hermes
      model: openai-codex:gpt-5.5
```
1b. Add `hermes` to the `SetupEngine` union type and to the doctor's engine binary checks (mirror the `grok` entries; install hint = the Hermes install one-liner).

- [ ] **Step 2: `talk/routes.ts`**

Add `"hermes"` to the valid-engine list (search where `"grok"` appears in the talk valid-engine set).

- [ ] **Step 3: Live `~/.cuttlefish/config.yaml`**

Add under `engines:`:
```yaml
  hermes:
    bin: hermes
    model: openai-codex:gpt-5.5
```
(Optional — the registry synthesizes if omitted — but adding it makes the default explicit.)

- [ ] **Step 4: Typecheck + commit**

```bash
cd packages/cuttlefish && npm run typecheck && cd ../..
git add packages/cuttlefish/src/cli/setup.ts packages/cuttlefish/src/talk/routes.ts
git commit -m "feat(hermes): setup template, doctor check, talk valid-engine list"
```
(The `~/.cuttlefish/config.yaml` edit is in a different repo — commit it there separately if that dir is version-controlled.)

---

## Task 9: Live integration test script (real binary)

**Files:**
- Create: `scripts/hermes-acp-smoke.mjs`

**Goal:** End-to-end proof against the actual installed `hermes` — handshake, streamed deltas, final text, and resume. Costs a few tokens; run manually.

- [ ] **Step 1: Write the script**

```js
// scripts/hermes-acp-smoke.mjs — run: node scripts/hermes-acp-smoke.mjs
import { spawn } from "node:child_process";
const proc = spawn("hermes", ["acp"], { stdio: ["pipe","pipe","ignore"], env: { ...process.env, HERMES_YOLO_MODE:"1", HERMES_ACCEPT_HOOKS:"1" } });
let buf = "", sid = null, answer = "", sawUsage = false, step = 0;
const send = (o) => proc.stdin.write(JSON.stringify(o)+"\n");
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let nl; while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0,nl).trim(); buf = buf.slice(nl+1); if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === 1 && m.result) send({jsonrpc:"2.0",id:2,method:"session/new",params:{cwd:"/tmp",mcpServers:[]}});
    else if (m.id === 2 && m.result) { sid = m.result.sessionId; console.log("MODELS:", JSON.stringify(m.result.models?.availableModels?.map(x=>x.modelId))); send({jsonrpc:"2.0",id:3,method:"session/prompt",params:{sessionId:sid,prompt:[{type:"text",text:"Reply with exactly the word: ok"}]}}); }
    else if (m.method === "session/update" && m.params.sessionId === sid) {
      const u = m.params.update;
      if (u.sessionUpdate?.startsWith("agent_message")) { const t = u.content?.text ?? u.text ?? ""; if (t) { answer += t; process.stdout.write("[TEXT] "+t+"\n"); } }
      if (u.sessionUpdate === "usage_update") { sawUsage = true; console.log("USAGE:", u.used, "/", u.size); }
    }
    else if (m.id === 3 && m.result) {
      console.log("STOP:", JSON.stringify(m.result));
      if (step === 0) { step = 1; // resume test: load same session in a fresh prompt
        send({jsonrpc:"2.0",id:4,method:"session/prompt",params:{sessionId:sid,prompt:[{type:"text",text:"Reply with exactly the word: again"}]}});
      }
    }
    else if (m.id === 4 && m.result) {
      console.log("RESUME-OK answer so far:", JSON.stringify(answer));
      console.log(answer.toLowerCase().includes("ok") && sawUsage ? "SMOKE PASS" : "SMOKE FAIL");
      proc.kill("SIGTERM"); process.exit(0);
    }
  }
});
send({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:1,clientCapabilities:{}}});
setTimeout(()=>{ console.log("TIMEOUT"); proc.kill("SIGTERM"); process.exit(1); }, 120000);
```

- [ ] **Step 2: Run it**

Run: `node scripts/hermes-acp-smoke.mjs`
Expected: prints `MODELS:[…]`, `[TEXT] ok`, `USAGE: <n> / <n>`, `STOP: …`, then `SMOKE PASS`. If it fails, inspect stderr by temporarily setting `stdio[2]` to `"inherit"`.

- [ ] **Step 3: Commit**

```bash
git add scripts/hermes-acp-smoke.mjs
git commit -m "test(hermes): live ACP smoke script (handshake, stream, resume)"
```

---

## Task 10: Isolated gateway on :7788 + Chrome verification

**Goal:** Prove the full path in a real gateway: engine + model picker, live streaming in web chat, resume, and the CLI Mode terminal — without touching the live :8888 instance.

- [ ] **Step 1: Build**

Run: `cd ~/Projects/cuttlefish && npm run -w packages/cuttlefish build` (or the repo's build script). Expected: dist emitted, no errors.

- [ ] **Step 2: Launch an isolated instance on :7788**

Use an isolated home + port so it never collides with live :8888:
```bash
CUTTLEFISH_HOME=/tmp/cuttlefish-7788-home PORT=7788 node ~/Projects/cuttlefish/packages/cuttlefish/dist/cli/index.js start --daemon 2>&1 | tail -5
```
(If a seed config is needed, run the `setup`/`postinstall` path first, or copy `~/.cuttlefish/config.yaml` into `/tmp/cuttlefish-7788-home` and ensure `engines.hermes` + valid credentials in `~/.hermes/.env` are reachable.) Confirm: `curl -s localhost:7788/api/status` returns ok and `curl -s localhost:7788/api/engines | jq '.engines.hermes'` shows the hermes entry with models.

- [ ] **Step 3: Create a Hermes session + smoke a turn via API**

```bash
curl -s -X POST localhost:7788/api/sessions -H 'content-type: application/json' \
  -d '{"engine":"hermes","prompt":"Reply with exactly: ok"}' | jq '{id,engine,status}'
```
Then poll `GET /api/sessions/<id>?last=5` until `status:"idle"` and assert the assistant message is present.

- [ ] **Step 4: Chrome verification** (Claude-in-Chrome)

Open `http://localhost:7788` in a new tab. Verify visually + capture a short GIF:
1. New chat → engine picker lists **Hermes**; selecting it shows the Hermes **models** in the model dropdown; the **effort** control is hidden.
2. Send a prompt → tokens **stream incrementally** (not one blob) into the bubble.
3. Send a second prompt in the same chat → **resume** works (coherent continuation), context meter updates.
4. Open the session's **CLI/terminal** tab → the real `hermes` TUI renders and accepts input.
Record findings; save the GIF to `/tmp/hermes-7788-verify.gif`.

- [ ] **Step 5: Tear down + note results**

```bash
# stop the isolated daemon (find PID via /api/status or the daemon file under CUTTLEFISH_HOME)
kill <pid>; rm -rf /tmp/cuttlefish-7788-home
```
Write a short PASS/FAIL note (with the GIF path) into the PR description / run log. No code commit unless a bug was found and fixed (then commit the fix with a test).

---

## Task 11: Docs, README, and opt-in persona

**Files:**
- Modify: `README.md` (engines table) and/or `packages/cuttlefish/README.md`
- Create: `docs/engines-hermes.md`
- Create: `~/.cuttlefish/org/platform/hermes-operator.yaml`

- [ ] **Step 1: README engines table**

Add a Hermes row to the engines list: what it is (NousResearch self-improving agent, model-agnostic), install hint (the one-liner), the two modes (Chat = ACP streaming, CLI = TUI view), `EFFORT_MECHANISM: none`, and the **metered-cost caveat** (Hermes owns its own loop and bills per token on its configured provider, unlike the subscription-wrapped engines).

- [ ] **Step 2: `docs/engines-hermes.md`**

Write a concise reference: invocation contract (`hermes acp` ndjson JSON-RPC; methods used), the `session/update` → `StreamDelta` map, model discovery (live from `session/new`), auto-approve mechanism (`HERMES_YOLO_MODE`/`HERMES_ACCEPT_HOOKS` + `dont_ask` + `allow_always`), config keys (`engines.hermes.bin/model`), and troubleshooting (binary not found → unavailable; provider/creds in `~/.hermes`).

- [ ] **Step 3: `hermes-operator.yaml` persona** (opt-in usage)

```yaml
name: hermes-operator
displayName: Hermes Operator
department: platform
rank: senior
engine: hermes
model: openai-codex:gpt-5.5
reportsTo: cuttlefish-dev
persona: |
  You are the Hermes Operator. You run tasks on the Hermes engine (NousResearch
  self-improving agent) — useful for jobs that benefit from Hermes's own tool
  loop, skills, and memory. You are metered (pay-per-token on the configured
  provider), so prefer Hermes for tasks that specifically need it; otherwise
  defer to subscription-backed engines.
oversight: VERIFY
```

- [ ] **Step 4: Commit**

```bash
git add README.md packages/cuttlefish/README.md docs/engines-hermes.md
git commit -m "docs(hermes): engines table, reference doc"
# persona lives in ~/.cuttlefish (separate repo) — commit there if versioned:
#   (cd ~/.cuttlefish && git add org/platform/hermes-operator.yaml && git commit -m "feat(org): hermes-operator employee")
```

---

## Task 12: Adversarial code review + fixes

- [ ] **Step 1: Full local gate**

Run: `cd packages/cuttlefish && npm run typecheck && npx vitest run`
Expected: all green. Fix any failures before review.

- [ ] **Step 2: Spawn the `code-reviewer` employee** (Codex GPT-5.5 xhigh) on the branch diff (`git diff main...feat/hermes-engine`). Brief it on: the ACP wire contract, the auto-approve requirement, the warm-per-session lifecycle, and the version-agnostic constraint. Loop rounds until all CRITICAL/HIGH (and chosen MEDIUM) findings are fixed, each fix with a regression test where applicable.

- [ ] **Step 3: Re-run the gate + the :7788 Chrome check** for anything the review touched.

- [ ] **Step 4: Final commit + report to the maintainer**

```bash
git add -A && git commit -m "fix(hermes): address adversarial review findings"
```
Report PASS/FAIL with the :7788 evidence (GIF + notes). Merge decision is the maintainer's.

---

## Self-Review (completed)

- **Spec coverage:** Chat Mode (Tasks 3,4) ✓; CLI Mode (Task 6) ✓; version/path-agnostic (Global Constraints + Task 5 `resolveBin`/discovery) ✓; picker model source (Tasks 2,5) ✓; effort=none (Tasks 5,6) ✓; auto-approve (Global + Tasks 2,4,6) ✓; warm-per-session (Task 4) ✓; registry/config/wiring (Tasks 5,7,8) ✓; live test + :7788 + Chrome (Tasks 9,10) ✓; README/docs/persona (Task 11) ✓; review (Task 12) ✓.
- **Placeholder scan:** Task 6's `PtyViewEngine` bodies say "copy grok-interactive's bodies" with the exact substitutions named — acceptable because the source is concrete and engine-agnostic; everything else inlines real code.
- **Type consistency:** `HermesModelDiscovery`, `HermesRpc`, `mapSessionUpdate`, `buildHermesEntry`, `refreshHermesModels`, `HermesAcpEngine`, `HermesInteractiveEngine`, `buildHermesInteractiveArgs`, `isHermesTuiReady` used consistently across tasks. Engine key `"hermes"` and `effortMechanism: "none"` consistent.
