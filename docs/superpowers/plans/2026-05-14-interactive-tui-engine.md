# Interactive TUI Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `InteractiveClaudeEngine` that drives the real interactive `claude` binary inside a PTY so Cuttlefish bills against interactive subscription limits instead of the post-June-15 Agent SDK credit, with a PTY lifecycle manager, hook-based turn completion, cost/rate-limit reconstruction, and a web "CLI mode".

**Architecture:** One engine core spawns the genuine `claude` binary via `node-pty` (no `-p` → `cc_entrypoint=cli`). Turn results arrive via a Claude Code `Stop` hook that POSTs to a new gateway endpoint; mid-turn progress comes from tailing the session transcript JSONL. A PTY lifecycle manager keyed on `session.id` owns process lifetime (kill-after-turn default / KEEP ALIVE / web grace period). The web UI gets a per-session Chat↔CLI toggle; CLI mode streams raw PTY bytes over a dedicated WebSocket into xterm.js.

**Tech Stack:** TypeScript, Node.js, `node-pty`, `better-sqlite3` (existing), `node:test`+`node:assert/strict` (existing test style), Next.js/React + `xterm.js` (web).

**Spec:** `docs/superpowers/specs/2026-05-14-interactive-tui-engine-design.md`

**Test commands:** single file - `npx tsx --test packages/cuttlefish/src/<path>.test.ts`; full daemon suite - `pnpm --filter @cuttlefishcuttlefish-cli test`; typecheck - `pnpm --filter @cuttlefishcuttlefish-cli typecheck`.

> **Assumptions to revisit after Phase 0** are tagged **[SPIKE-DEP]**. If a Phase 0 finding contradicts an assumption, update the affected task before implementing it.

---

## Phase 0 - Validation Spike

Exploratory, not TDD. Each task runs a real `claude` (v2.1.141 is installed) and records findings into the spec's "Open Questions / Validation Steps" section (mark each line RESOLVED/CHANGED with the finding). Reuse `/tmp/cuttlefish-tui-poc/` from the original POC (hook scripts + settings.json already exist there; trust is seeded under `/private/tmp/cuttlefish-tui-poc`).

### Task 0.1: Confirm `--resume "<prompt>"` auto-submits + bracketed-paste follow-ups

**Files:**
- Modify: `docs/superpowers/specs/2026-05-14-interactive-tui-engine-design.md` (Open Questions section)

- [ ] **Step 1: Resume auto-submit test.** Run a fresh POC turn (as in the original POC), capture the `session_id` from `result-stop-payload.json`. Then run `script -q /dev/null claude --resume <session_id> --settings /private/tmp/cuttlefish-tui-poc/settings.json --dangerously-skip-permissions "Reply with exactly RESUME_OK"` in the background; wait for `STOP_FIRED`; confirm `last_assistant_message` is `RESUME_OK`. Record result.

- [ ] **Step 2: Bracketed-paste follow-up test.** Spawn `script -q /dev/null claude --settings .../settings.json --dangerously-skip-permissions` with NO prompt arg, keeping stdin open (use a FIFO: `mkfifo /tmp/cuttlefish-tui-poc/in; script -q /dev/null ... < /tmp/cuttlefish-tui-poc/in &`). After ~3s, write `printf '\033[200~Reply with exactly PASTE_OK\033[201~\r' > /tmp/cuttlefish-tui-poc/in`. Wait for `STOP_FIRED`; confirm `last_assistant_message` is `PASTE_OK`. Then write a second paste with a `/`-prefixed line to confirm paste-mode neutralizes it. Record results.

- [ ] **Step 3: Record findings** in the spec, marking the two relevant Open Questions RESOLVED or CHANGED. If resume-with-prompt does NOT auto-submit, note that every turn must use the FIFO/paste path and update Task 4.3.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-05-14-interactive-tui-engine-design.md
git commit -m "spike: validate --resume auto-submit and bracketed-paste injection"
```

### Task 0.2: Confirm flag compatibility + ARG_MAX

**Files:**
- Modify: `docs/superpowers/specs/2026-05-14-interactive-tui-engine-design.md`

- [ ] **Step 1: `--effort` / `--chrome` test.** Run `script -q /dev/null claude --effort high --chrome --settings .../settings.json --dangerously-skip-permissions "Reply with exactly FLAGS_OK"`. Confirm it reaches the `Stop` hook (no arg-parse error, no crash). Inspect `raw-pty-output.log` for any error banner. Record.

- [ ] **Step 2: ARG_MAX test.** Generate a ~120 KB string and pass it via `--append-system-prompt "<bigstring>" "Reply with exactly ARG_OK"`. If it fails with `E2BIG`/`spawn` error, ARG_MAX is real. Then test the alternative: put the same string under `hooks`-less key... actually test `--settings` with an inline `appendSystemPrompt`-equivalent - write a settings file containing a large value and confirm it loads. Record which path works.

- [ ] **Step 3: Record findings**, marking Open Questions. If `--effort` or `--chrome` is interactive-incompatible, note the regression and update Task 4.2's flag list. If ARG_MAX is real, Task 2.1 must carry the system prompt in the settings file.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-05-14-interactive-tui-engine-design.md
git commit -m "spike: validate --effort/--chrome and system-prompt ARG_MAX"
```

### Task 0.3: Identify cost + rate-limit data sources

**Files:**
- Modify: `docs/superpowers/specs/2026-05-14-interactive-tui-engine-design.md`

- [ ] **Step 1: Cost source.** After a POC turn, inspect the transcript JSONL at the `transcript_path` from the Stop payload: `cat <path> | python3 -c "import sys,json; [print(json.dumps(json.loads(l).get('message',{}).get('usage'))) for l in sys.stdin if l.strip()]"`. Confirm whether `assistant` lines carry a `usage` block (input/output/cache tokens). Also check `~/.claude.json` → `projects[<realpath>]` for `lastCost` / `lastModelUsage`. Record which is reliable.

- [ ] **Step 2: Rate-limit source.** Inspect the POC `settings.json` hook list - add a `Notification` hook (same relay pattern) and a `SessionEnd` hook, rerun a turn, see what payloads arrive. Document whether any structured rate-limit signal is reachable. (A true rate-limit can't be forced on demand - document the *mechanism*, not a live hit.)

- [ ] **Step 3: Record findings.** Update the spec's "cost & turn tracking" and "rate-limit detection" components with the concrete chosen source. If neither cost source is reliable, the spec's fallback (disable budget enforcement in interactive mode + loud warning) becomes the plan - update Task 5.1.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-05-14-interactive-tui-engine-design.md
git commit -m "spike: identify cost and rate-limit data sources for interactive mode"
```

---

## Phase 1 - Foundations: config, gateway.json, node-pty

### Task 1.1: Extend config types + defaulting

**Files:**
- Modify: `packages/cuttlefish/src/shared/types.ts:385-387` (the `engines` block) and `:384` (`gateway`)
- Modify: `packages/cuttlefish/src/shared/config.ts`
- Test: `packages/cuttlefish/src/shared/config.test.ts`

- [ ] **Step 1: Extend the `CuttlefishConfig` types.** In `types.ts`, change the `claude` engine type and add interactive knobs:

```ts
claude: {
  bin: string;
  model: string;
  effortLevel?: string;
  childEffortOverride?: string;
  /** "headless" = claude -p (default, legacy). "interactive" = PTY-driven TUI. Restart-only. */
  mode?: "headless" | "interactive";
  /** Default KEEP ALIVE for sessions (web UI control overrides per-session). */
  keepAlive?: boolean;
  /** Hard idle cap for warm PTYs, ms. Default 1_800_000 (30m). */
  idleTimeoutMs?: number;
  /** Grace window for recently-viewed web sessions, ms. Default 300_000 (5m). */
  graceWindowMs?: number;
  /** Turn-completion watchdog timeout, ms. Default 600_000 (10m). */
  turnTimeoutMs?: number;
  /** Max concurrent live PTYs across all sessions. Default 8. */
  maxLivePtys?: number;
};
```

- [ ] **Step 2: Write the failing test** for a `normalizeConfig` helper:

```ts
// packages/cuttlefish/src/shared/config.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeClaudeEngineConfig } from "./config.js";

test("normalizeClaudeEngineConfig defaults mode to headless when missing", () => {
  const out = normalizeClaudeEngineConfig({ bin: "claude", model: "opus" });
  assert.equal(out.mode, "headless");
});

test("normalizeClaudeEngineConfig coerces a garbage mode to headless", () => {
  const out = normalizeClaudeEngineConfig({ bin: "claude", model: "opus", mode: "banana" as any });
  assert.equal(out.mode, "headless");
});

test("normalizeClaudeEngineConfig keeps a valid interactive mode and applies timeout defaults", () => {
  const out = normalizeClaudeEngineConfig({ bin: "claude", model: "opus", mode: "interactive" });
  assert.equal(out.mode, "interactive");
  assert.equal(out.idleTimeoutMs, 1_800_000);
  assert.equal(out.graceWindowMs, 300_000);
  assert.equal(out.turnTimeoutMs, 600_000);
  assert.equal(out.maxLivePtys, 8);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx --test packages/cuttlefish/src/shared/config.test.ts`
Expected: FAIL - `normalizeClaudeEngineConfig` not exported.

- [ ] **Step 4: Implement `normalizeClaudeEngineConfig`** in `config.ts`:

```ts
import type { CuttlefishConfig } from "./types.js";
type ClaudeEngineConfig = CuttlefishConfig["engines"]["claude"];

export function normalizeClaudeEngineConfig(raw: ClaudeEngineConfig): Required<Pick<ClaudeEngineConfig,
  "mode" | "idleTimeoutMs" | "graceWindowMs" | "turnTimeoutMs" | "maxLivePtys">> & ClaudeEngineConfig {
  const mode = raw.mode === "interactive" ? "interactive" : "headless";
  return {
    ...raw,
    mode,
    keepAlive: raw.keepAlive ?? false,
    idleTimeoutMs: raw.idleTimeoutMs ?? 1_800_000,
    graceWindowMs: raw.graceWindowMs ?? 300_000,
    turnTimeoutMs: raw.turnTimeoutMs ?? 600_000,
    maxLivePtys: raw.maxLivePtys ?? 8,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test packages/cuttlefish/src/shared/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Apply normalization in `loadConfig`.** In `config.ts`, after `yaml.load`, normalize the claude engine block:

```ts
const config = yaml.load(raw) as CuttlefishConfig;
config.engines.claude = normalizeClaudeEngineConfig(config.engines.claude);
return config;
```

- [ ] **Step 7: Add `source` to `EngineRunOpts`.** The interactive engine needs to know if a turn is cron-originated (cron sessions are KEEP-ALIVE-ineligible). In `types.ts`, add to `EngineRunOpts` (after `sessionId`):

```ts
  /** Session source ("cron", "web", "slack", …) - used by the interactive engine for lifecycle policy. */
  source?: string;
```

Then update the two `engine.run({...})` call sites to pass it: `manager.ts` `runSession` passes `source: session.source`; `api.ts` `runWebSession` passes `source: currentSession.source`. (The rate-limit retry loops in both files should pass it too.)

- [ ] **Step 8: Run typecheck + commit**

```bash
pnpm --filter @cuttlefishcuttlefish-cli typecheck
git add packages/cuttlefish/src/shared/types.ts packages/cuttlefish/src/shared/config.ts packages/cuttlefish/src/shared/config.test.ts packages/cuttlefish/src/sessions/manager.ts packages/cuttlefish/src/gateway/api.ts
git commit -m "feat(config): interactive engine config keys + normalization + EngineRunOpts.source"
```

### Task 1.2: Add `mode: headless` to the setup default config

**Files:**
- Modify: `packages/cuttlefish/src/cli/setup.ts` (the `DEFAULT_CONFIG` literal - search for `claude:` under `engines:`)

- [ ] **Step 1: Locate and update.** In `setup.ts`, find the `DEFAULT_CONFIG` YAML/object literal's `engines.claude` block and add `mode: headless` explicitly so new installs are unambiguous.

- [ ] **Step 2: Typecheck + commit**

```bash
pnpm --filter @cuttlefishcuttlefish-cli typecheck
git add packages/cuttlefish/src/cli/setup.ts
git commit -m "feat(setup): emit explicit engines.claude.mode in default config"
```

### Task 1.3: Add `node-pty` dependency + `gateway.json` paths

**Files:**
- Modify: `packages/cuttlefish/package.json` (dependencies)
- Modify: `packages/cuttlefish/src/shared/paths.ts`

- [ ] **Step 1: Add dependency.** Run `pnpm --filter @cuttlefishcuttlefish-cli add node-pty`. Verify it installs a prebuild (no compiler error). Record the resolved version.

- [ ] **Step 2: Add paths.** In `paths.ts`, after `PID_FILE`:

```ts
/** Gateway connection info (port + hook secret + pids) for hook-relay discovery. */
export const GATEWAY_INFO_FILE = path.join(CUTTLEFISH_HOME, "gateway.json");
/** Per-session Claude Code --settings files. */
export const CLAUDE_SETTINGS_DIR = path.join(CUTTLEFISH_HOME, "tmp", "settings");
/** The hook-relay script written once at boot. */
export const HOOK_RELAY_SCRIPT = path.join(CUTTLEFISH_HOME, "hook-relay.mjs");
```

- [ ] **Step 3: Commit**

```bash
git add packages/cuttlefish/package.json packages/cuttlefish/pnpm-lock.yaml packages/cuttlefish/src/shared/paths.ts pnpm-lock.yaml
git commit -m "chore: add node-pty dependency and interactive-engine paths"
```

### Task 1.4: `gateway-info.ts` - write/read `gateway.json`

**Files:**
- Create: `packages/cuttlefish/src/gateway/gateway-info.ts`
- Test: `packages/cuttlefish/src/gateway/gateway-info.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeGatewayInfo, readGatewayInfo } from "./gateway-info.js";

test("writeGatewayInfo round-trips and generates a secret", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-"));
  const file = path.join(dir, "gateway.json");
  const info = writeGatewayInfo(file, { port: 8888, pid: 1234 });
  assert.equal(info.port, 8888);
  assert.equal(info.pid, 1234);
  assert.equal(typeof info.secret, "string");
  assert.ok(info.secret.length >= 32);
  const read = readGatewayInfo(file);
  assert.deepEqual(read, info);
});

test("readGatewayInfo returns null when the file is missing", () => {
  assert.equal(readGatewayInfo("/nonexistent/gateway.json"), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/cuttlefish/src/gateway/gateway-info.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement**

```ts
import fs from "node:fs";
import crypto from "node:crypto";

export interface GatewayInfo { port: number; secret: string; pid: number; ptyPids?: number[]; }

export function writeGatewayInfo(file: string, opts: { port: number; pid: number; secret?: string }): GatewayInfo {
  const info: GatewayInfo = {
    port: opts.port,
    pid: opts.pid,
    secret: opts.secret ?? crypto.randomBytes(24).toString("hex"),
    ptyPids: [],
  };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2));
  fs.renameSync(tmp, file);
  return info;
}

export function readGatewayInfo(file: string): GatewayInfo | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as GatewayInfo;
  } catch {
    return null;
  }
}

export function updateGatewayPtyPids(file: string, ptyPids: number[]): void {
  const info = readGatewayInfo(file);
  if (!info) return;
  info.ptyPids = ptyPids;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2));
  fs.renameSync(tmp, file);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/cuttlefish/src/gateway/gateway-info.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cuttlefish/src/gateway/gateway-info.ts packages/cuttlefish/src/gateway/gateway-info.test.ts
git commit -m "feat(gateway): gateway.json writer/reader for hook-relay discovery"
```

---

## Phase 2 - Hook infrastructure

### Task 2.1: `claude-settings.ts` - per-session settings file + trust seeding

**Files:**
- Create: `packages/cuttlefish/src/shared/claude-settings.ts`
- Test: `packages/cuttlefish/src/shared/claude-settings.test.ts`

**[SPIKE-DEP]** If Task 0.2 found ARG_MAX is real, `buildSessionSettings` must accept and embed `appendSystemPrompt`. The code below already supports it.

- [ ] **Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSessionSettings, writeSessionSettings, sessionSettingsPath, seedTrust } from "./claude-settings.js";

test("buildSessionSettings registers Stop/SessionStart/StopFailure hooks pointing at the relay with the session id", () => {
  const s = buildSessionSettings({ sessionId: "cuttlefish-abc", relayScript: "/h/relay.mjs", appendSystemPrompt: "SYS" });
  const stop = s.hooks.Stop[0].hooks[0];
  assert.equal(stop.type, "command");
  assert.match(stop.command, /relay\.mjs.*cuttlefish-abc/);
  assert.ok(s.hooks.SessionStart && s.hooks.PreToolUse && s.hooks.PostToolUse && s.hooks.StopFailure);
  assert.equal(s.appendSystemPrompt, "SYS");
});

test("writeSessionSettings writes atomically and is readable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-"));
  const p = writeSessionSettings(dir, "cuttlefish-xyz", { sessionId: "cuttlefish-xyz", relayScript: "/h/relay.mjs" });
  assert.equal(p, sessionSettingsPath(dir, "cuttlefish-xyz"));
  const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
  assert.ok(parsed.hooks.Stop);
  assert.ok(!fs.existsSync(`${p}.tmp`));
});

test("seedTrust is idempotent and uses the realpath", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
  const claudeJson = path.join(home, ".claude.json");
  const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "proj-")));
  seedTrust(claudeJson, projectDir);
  seedTrust(claudeJson, projectDir);
  const d = JSON.parse(fs.readFileSync(claudeJson, "utf-8"));
  assert.equal(d.projects[projectDir].hasTrustDialogAccepted, true);
  assert.equal(d.projects[projectDir].hasCompletedProjectOnboarding, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/cuttlefish/src/shared/claude-settings.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement**

```ts
import fs from "node:fs";
import path from "node:path";

export interface SessionSettingsOpts {
  sessionId: string;
  relayScript: string;
  appendSystemPrompt?: string;
}

interface HookCommand { type: "command"; command: string; }
interface HookMatcher { hooks: HookCommand[]; }

// StopFailure fires INSTEAD of Stop when an API error ends the turn (rate_limit,
// billing_error, server_error, …) - confirmed by the Phase 0 spike. It is the
// structured rate-limit signal, so it must be registered alongside Stop.
export interface ClaudeSettings {
  hooks: Record<"SessionStart" | "Stop" | "StopFailure" | "PreToolUse" | "PostToolUse", HookMatcher[]>;
  appendSystemPrompt?: string;
}

export function buildSessionSettings(opts: SessionSettingsOpts): ClaudeSettings {
  // Relay is invoked as: node <relayScript> <cuttlefishSessionId>
  // It reads the hook JSON on stdin and POSTs to the gateway.
  const cmd = (): HookMatcher => ({
    hooks: [{ type: "command", command: `node ${opts.relayScript} ${opts.sessionId}` }],
  });
  return {
    hooks: {
      SessionStart: [cmd()],
      Stop: [cmd()],
      StopFailure: [cmd()],
      PreToolUse: [cmd()],
      PostToolUse: [cmd()],
    },
    ...(opts.appendSystemPrompt ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
  };
}

export function sessionSettingsPath(dir: string, sessionId: string): string {
  return path.join(dir, `${sessionId}.json`);
}

export function writeSessionSettings(dir: string, sessionId: string, opts: SessionSettingsOpts): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = sessionSettingsPath(dir, sessionId);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(buildSessionSettings(opts), null, 2));
  fs.renameSync(tmp, filePath);
  return filePath;
}

export function cleanupSessionSettings(dir: string, sessionId: string): void {
  try { fs.unlinkSync(sessionSettingsPath(dir, sessionId)); } catch { /* best effort */ }
}

/** Idempotently mark a project directory trusted in the real ~/.claude.json. */
export function seedTrust(claudeJsonPath: string, projectDir: string): void {
  const realDir = fs.realpathSync(projectDir);
  let data: any = {};
  try { data = JSON.parse(fs.readFileSync(claudeJsonPath, "utf-8")); } catch { /* new file */ }
  data.projects ??= {};
  const proj = (data.projects[realDir] ??= {});
  if (proj.hasTrustDialogAccepted === true && proj.hasCompletedProjectOnboarding === true) return;
  proj.hasTrustDialogAccepted = true;
  proj.hasCompletedProjectOnboarding = true;
  proj.allowedTools ??= [];
  const tmp = `${claudeJsonPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, claudeJsonPath);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/cuttlefish/src/shared/claude-settings.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cuttlefish/src/shared/claude-settings.ts packages/cuttlefish/src/shared/claude-settings.test.ts
git commit -m "feat: per-session Claude settings file + trust seeding helpers"
```

### Task 2.2: The hook-relay script

**Files:**
- Create: `packages/cuttlefish/assets/hook-relay.mjs` (source-of-truth, copied to `CUTTLEFISH_HOME` at boot)

- [ ] **Step 1: Write the relay script.** It is invoked by Claude Code as `node hook-relay.mjs <cuttlefishSessionId>`, reads the hook JSON on stdin, and POSTs to the gateway. It must never throw (exit 0 always) and must not block Claude.

```js
#!/usr/bin/env node
// Cuttlefish hook relay. Invoked by Claude Code hooks as: node hook-relay.mjs <cuttlefishSessionId>
// Reads hook JSON on stdin, POSTs to the gateway's /api/internal/hook. Always exits 0.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const cuttlefishSessionId = process.argv[2];
const CUTTLEFISH_HOME = process.env.CUTTLEFISH_HOME || path.join(os.homedir(), ".cuttlefish");

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let payload;
  try { payload = JSON.parse(raw); } catch { return; }

  let info;
  try { info = JSON.parse(fs.readFileSync(path.join(CUTTLEFISH_HOME, "gateway.json"), "utf-8")); } catch { return; }

  const body = JSON.stringify({ cuttlefishSessionId, hook: payload });
  await fetch(`http://127.0.0.1:${info.port}/api/internal/hook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cuttlefish-hook-secret": info.secret },
    body,
  }).catch(() => {});
}

main().catch(() => {}).finally(() => process.exit(0));
```

- [ ] **Step 2: Manual smoke test.** `echo '{"hook_event_name":"Stop","session_id":"x"}' | CUTTLEFISH_HOME=/tmp node packages/cuttlefish/assets/hook-relay.mjs cuttlefish-test` - confirm it exits 0 cleanly even with no gateway running (the `fetch` rejection is swallowed).

- [ ] **Step 3: Commit**

```bash
git add packages/cuttlefish/assets/hook-relay.mjs
git commit -m "feat: Claude Code hook-relay script"
```

### Task 2.3: Hook payload buffer + resolver registry

**Files:**
- Create: `packages/cuttlefish/src/gateway/hook-registry.ts`
- Test: `packages/cuttlefish/src/gateway/hook-registry.test.ts`

This module solves the hook-vs-`run()` race: it buffers hook payloads for sessions whose resolver isn't registered yet, and drains the buffer on registration.

- [ ] **Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { HookRegistry } from "./hook-registry.js";

test("HookRegistry delivers a hook that arrives AFTER registration", () => {
  const reg = new HookRegistry();
  const seen: string[] = [];
  reg.register("s1", (h) => seen.push(h.hook_event_name));
  reg.deliver("s1", { hook_event_name: "SessionStart" } as any);
  assert.deepEqual(seen, ["SessionStart"]);
});

test("HookRegistry buffers a hook that arrives BEFORE registration and drains on register", () => {
  const reg = new HookRegistry();
  const seen: string[] = [];
  reg.deliver("s2", { hook_event_name: "SessionStart" } as any);
  assert.deepEqual(seen, []);
  reg.register("s2", (h) => seen.push(h.hook_event_name));
  assert.deepEqual(seen, ["SessionStart"]);
});

test("HookRegistry.unregister stops delivery and clears buffer", () => {
  const reg = new HookRegistry();
  const seen: string[] = [];
  reg.register("s3", (h) => seen.push(h.hook_event_name));
  reg.unregister("s3");
  reg.deliver("s3", { hook_event_name: "Stop" } as any);
  assert.deepEqual(seen, []);
});

test("HookRegistry drops buffered hooks past TTL", async () => {
  const reg = new HookRegistry(20); // 20ms TTL
  reg.deliver("s4", { hook_event_name: "SessionStart" } as any);
  await new Promise((r) => setTimeout(r, 40));
  const seen: string[] = [];
  reg.register("s4", (h) => seen.push(h.hook_event_name));
  assert.deepEqual(seen, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/cuttlefish/src/gateway/hook-registry.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement**

```ts
export interface HookPayload {
  hook_event_name: "SessionStart" | "Stop" | "StopFailure" | "PreToolUse" | "PostToolUse" | string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  last_assistant_message?: string;
  tool_name?: string;
  /** Present on StopFailure: enum - rate_limit | authentication_failed | billing_error | invalid_request | server_error | max_output_tokens | unknown */
  error?: string;
  error_details?: string;
  [k: string]: unknown;
}

type HookListener = (h: HookPayload) => void;
interface Buffered { payload: HookPayload; at: number; }

export class HookRegistry {
  private listeners = new Map<string, HookListener>();
  private buffer = new Map<string, Buffered[]>();
  constructor(private ttlMs = 30_000) {}

  register(cuttlefishSessionId: string, listener: HookListener): void {
    this.listeners.set(cuttlefishSessionId, listener);
    const pending = this.buffer.get(cuttlefishSessionId);
    if (pending) {
      this.buffer.delete(cuttlefishSessionId);
      const now = Date.now();
      for (const b of pending) {
        if (now - b.at <= this.ttlMs) listener(b.payload);
      }
    }
  }

  unregister(cuttlefishSessionId: string): void {
    this.listeners.delete(cuttlefishSessionId);
    this.buffer.delete(cuttlefishSessionId);
  }

  deliver(cuttlefishSessionId: string, payload: HookPayload): void {
    const listener = this.listeners.get(cuttlefishSessionId);
    if (listener) { listener(payload); return; }
    const arr = this.buffer.get(cuttlefishSessionId) ?? [];
    arr.push({ payload, at: Date.now() });
    this.buffer.set(cuttlefishSessionId, arr);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/cuttlefish/src/gateway/hook-registry.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cuttlefish/src/gateway/hook-registry.ts packages/cuttlefish/src/gateway/hook-registry.test.ts
git commit -m "feat(gateway): hook payload buffer + resolver registry (race-safe)"
```

### Task 2.4: `/api/internal/hook` endpoint

**Files:**
- Create: `packages/cuttlefish/src/gateway/hook-endpoint.ts`
- Modify: `packages/cuttlefish/src/gateway/api.ts` (route registration in `handleApiRequest`)
- Test: `packages/cuttlefish/src/gateway/hook-endpoint.test.ts`

- [ ] **Step 1: Read `api.ts:285-340`** to confirm the `matchRoute` helper, `readJsonBody`, and where in the `if` chain to insert the new route. Note the `ApiContext` shape.

- [ ] **Step 2: Write the failing test** for the auth+routing logic (pure function, no HTTP server):

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { handleHookPost } from "./hook-endpoint.js";
import { HookRegistry } from "./hook-registry.js";

function ctx() {
  const reg = new HookRegistry();
  return { reg, secret: "sek", remoteAddress: "127.0.0.1" };
}

test("handleHookPost rejects a wrong secret with 403", () => {
  const { reg } = ctx();
  const res = handleHookPost({ reg, secret: "sek", remoteAddress: "127.0.0.1" },
    "nope", { cuttlefishSessionId: "s1", hook: { hook_event_name: "Stop" } });
  assert.equal(res.status, 403);
});

test("handleHookPost rejects a non-loopback remote with 403", () => {
  const { reg } = ctx();
  const res = handleHookPost({ reg, secret: "sek", remoteAddress: "10.0.0.5" },
    "sek", { cuttlefishSessionId: "s1", hook: { hook_event_name: "Stop" } });
  assert.equal(res.status, 403);
});

test("handleHookPost delivers a valid hook to the registry and returns 200", () => {
  const { reg } = ctx();
  const seen: string[] = [];
  reg.register("s1", (h) => seen.push(h.hook_event_name));
  const res = handleHookPost({ reg, secret: "sek", remoteAddress: "127.0.0.1" },
    "sek", { cuttlefishSessionId: "s1", hook: { hook_event_name: "Stop", last_assistant_message: "hi" } });
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ["Stop"]);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx --test packages/cuttlefish/src/gateway/hook-endpoint.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 4: Implement `hook-endpoint.ts`**

```ts
import type { HookRegistry, HookPayload } from "./hook-registry.js";

export interface HookEndpointCtx {
  reg: HookRegistry;
  secret: string;
  remoteAddress: string | undefined;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function handleHookPost(
  ctx: HookEndpointCtx,
  providedSecret: string | undefined,
  body: { cuttlefishSessionId?: string; hook?: HookPayload },
): { status: number; body: string } {
  if (!ctx.remoteAddress || !LOOPBACK.has(ctx.remoteAddress)) {
    return { status: 403, body: "forbidden" };
  }
  if (providedSecret !== ctx.secret) {
    return { status: 403, body: "forbidden" };
  }
  if (!body.cuttlefishSessionId || !body.hook?.hook_event_name) {
    return { status: 400, body: "bad request" };
  }
  ctx.reg.deliver(body.cuttlefishSessionId, body.hook);
  return { status: 200, body: "ok" };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test packages/cuttlefish/src/gateway/hook-endpoint.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Wire the route into `api.ts`.** In `handleApiRequest`, near the other route blocks, add (using the `HookRegistry` instance and gateway secret which must be on `ApiContext` - add them there; populate at server boot in Task 6.x):

```ts
if (method === "POST" && pathname === "/api/internal/hook") {
  const body = await readJsonBody(req);
  const res = handleHookPost(
    { reg: context.hookRegistry, secret: context.hookSecret, remoteAddress: req.socket.remoteAddress },
    req.headers["x-cuttlefish-hook-secret"] as string | undefined,
    body,
  );
  return sendJson(sendResponse ?? res, res.status, { ok: res.status === 200 });
}
```

(Match the exact `api.ts` response-sending convention found in Step 1 - adapt the last line.)

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm --filter @cuttlefishcuttlefish-cli typecheck
git add packages/cuttlefish/src/gateway/hook-endpoint.ts packages/cuttlefish/src/gateway/hook-endpoint.test.ts packages/cuttlefish/src/gateway/api.ts
git commit -m "feat(gateway): /api/internal/hook endpoint with loopback+secret auth"
```

---

## Phase 3 - PTY lifecycle manager

### Task 3.1: Lifecycle decision logic (pure)

**Files:**
- Create: `packages/cuttlefish/src/engines/pty-lifecycle-policy.ts`
- Test: `packages/cuttlefish/src/engines/pty-lifecycle-policy.test.ts`

Split the *decision* (pure, testable) from the *process management* (Task 3.2).

- [ ] **Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { shouldStayAlive } from "./pty-lifecycle-policy.js";

const base = { turnRunning: false, keepAlive: false, lastViewedAt: 0, now: 1_000_000, graceWindowMs: 300_000, cronOrigin: false };

test("stays alive while a turn is running", () => {
  assert.equal(shouldStayAlive({ ...base, turnRunning: true }), true);
});
test("stays alive when KEEP ALIVE is set and not cron-origin", () => {
  assert.equal(shouldStayAlive({ ...base, keepAlive: true }), true);
});
test("KEEP ALIVE is ignored for cron-origin sessions", () => {
  assert.equal(shouldStayAlive({ ...base, keepAlive: true, cronOrigin: true }), false);
});
test("stays alive within the grace window after a recent view", () => {
  assert.equal(shouldStayAlive({ ...base, lastViewedAt: 1_000_000 - 100_000 }), true);
});
test("dies once the grace window has elapsed", () => {
  assert.equal(shouldStayAlive({ ...base, lastViewedAt: 1_000_000 - 400_000 }), false);
});
test("idle session with nothing set dies", () => {
  assert.equal(shouldStayAlive(base), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/cuttlefish/src/engines/pty-lifecycle-policy.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement**

```ts
export interface LifecycleInputs {
  turnRunning: boolean;
  keepAlive: boolean;
  cronOrigin: boolean;
  lastViewedAt: number; // epoch ms, 0 = never
  now: number;
  graceWindowMs: number;
}

export function shouldStayAlive(i: LifecycleInputs): boolean {
  if (i.turnRunning) return true;
  if (i.keepAlive && !i.cronOrigin) return true;
  if (i.lastViewedAt > 0 && i.now - i.lastViewedAt <= i.graceWindowMs) return true;
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/cuttlefish/src/engines/pty-lifecycle-policy.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cuttlefish/src/engines/pty-lifecycle-policy.ts packages/cuttlefish/src/engines/pty-lifecycle-policy.test.ts
git commit -m "feat(engine): pure PTY lifecycle decision policy"
```

### Task 3.2: `PtyLifecycleManager`

**Files:**
- Create: `packages/cuttlefish/src/engines/pty-lifecycle.ts`
- Test: `packages/cuttlefish/src/engines/pty-lifecycle.test.ts`

Owns live PTY handles **keyed by `session.id`**, the per-session `--settings` file lifetime, the idle/grace timers, and the global PTY cap. The actual `node-pty` spawn happens in the engine (Task 4); the manager stores an opaque handle and a `kill` callback.

- [ ] **Step 1: Write the failing test** (uses a fake handle - no real PTY)

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { PtyLifecycleManager } from "./pty-lifecycle.js";

function fakeHandle() {
  const h: any = { killed: false, pid: Math.floor(Math.random() * 9999) };
  h.kill = () => { h.killed = true; };
  return h;
}

test("registers a PTY and reports it as warm", () => {
  const m = new PtyLifecycleManager({ graceWindowMs: 1000, idleTimeoutMs: 10000, maxLivePtys: 8 });
  const h = fakeHandle();
  m.adopt("sess-1", h, { cronOrigin: false });
  assert.equal(m.getWarm("sess-1"), h);
});

test("releaseSession kills the PTY, cleans the handle, and fires onCleanup", () => {
  let cleaned = "";
  const m = new PtyLifecycleManager({ graceWindowMs: 1000, idleTimeoutMs: 10000, maxLivePtys: 8, onCleanup: (id) => { cleaned = id; } });
  const h = fakeHandle();
  m.adopt("sess-2", h, { cronOrigin: false });
  m.releaseSession("sess-2");
  assert.equal(h.killed, true);
  assert.equal(m.getWarm("sess-2"), undefined);
  assert.equal(cleaned, "sess-2");
});

test("a cron-origin PTY is killed on turnEnded even if keepAlive is requested", () => {
  const m = new PtyLifecycleManager({ graceWindowMs: 1000, idleTimeoutMs: 10000, maxLivePtys: 8 });
  const h = fakeHandle();
  m.adopt("sess-3", h, { cronOrigin: true });
  m.setKeepAlive("sess-3", true);
  m.turnEnded("sess-3");
  assert.equal(h.killed, true);
});

test("a keepAlive non-cron PTY survives turnEnded", () => {
  const m = new PtyLifecycleManager({ graceWindowMs: 1000, idleTimeoutMs: 10000, maxLivePtys: 8 });
  const h = fakeHandle();
  m.adopt("sess-4", h, { cronOrigin: false });
  m.setKeepAlive("sess-4", true);
  m.turnEnded("sess-4");
  assert.equal(h.killed, false);
});

test("isAtCapacity is true once maxLivePtys is reached", () => {
  const m = new PtyLifecycleManager({ graceWindowMs: 1000, idleTimeoutMs: 10000, maxLivePtys: 2 });
  m.adopt("a", fakeHandle(), { cronOrigin: false });
  m.adopt("b", fakeHandle(), { cronOrigin: false });
  assert.equal(m.isAtCapacity(), true);
});

test("markViewed extends life past turnEnded within the grace window", () => {
  const m = new PtyLifecycleManager({ graceWindowMs: 60_000, idleTimeoutMs: 600_000, maxLivePtys: 8 });
  const h = fakeHandle();
  m.adopt("sess-5", h, { cronOrigin: false });
  m.markViewed("sess-5");
  m.turnEnded("sess-5");
  assert.equal(h.killed, false);
});

test("killAll kills every live PTY", () => {
  const m = new PtyLifecycleManager({ graceWindowMs: 1000, idleTimeoutMs: 10000, maxLivePtys: 8 });
  const a = fakeHandle(), b = fakeHandle();
  m.adopt("a", a, { cronOrigin: false });
  m.adopt("b", b, { cronOrigin: false });
  m.killAll();
  assert.equal(a.killed, true);
  assert.equal(b.killed, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/cuttlefish/src/engines/pty-lifecycle.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement**

```ts
import { shouldStayAlive } from "./pty-lifecycle-policy.js";

export interface PtyHandle {
  pid: number;
  killed: boolean;
  kill: (signal?: string) => void;
}

export interface PtyLifecycleOpts {
  graceWindowMs: number;
  idleTimeoutMs: number;
  maxLivePtys: number;
  /** Called after a PTY is killed/removed - used to clean the --settings file, hook registry, gateway.json pids. */
  onCleanup?: (sessionId: string) => void;
}

interface Entry {
  handle: PtyHandle;
  cronOrigin: boolean;
  keepAlive: boolean;
  turnRunning: boolean;
  lastViewedAt: number;
  lastActivityAt: number;
}

export class PtyLifecycleManager {
  private entries = new Map<string, Entry>();
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(private opts: PtyLifecycleOpts) {
    this.sweepTimer = setInterval(() => this.sweep(), 30_000);
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  adopt(sessionId: string, handle: PtyHandle, meta: { cronOrigin: boolean }): void {
    this.entries.set(sessionId, {
      handle, cronOrigin: meta.cronOrigin, keepAlive: false,
      turnRunning: false, lastViewedAt: 0, lastActivityAt: Date.now(),
    });
  }

  getWarm(sessionId: string): PtyHandle | undefined {
    return this.entries.get(sessionId)?.handle;
  }

  isAtCapacity(): boolean {
    return this.entries.size >= this.opts.maxLivePtys;
  }

  livePids(): number[] {
    return [...this.entries.values()].map((e) => e.handle.pid);
  }

  setKeepAlive(sessionId: string, on: boolean): void {
    const e = this.entries.get(sessionId);
    if (e) { e.keepAlive = on; this.reevaluate(sessionId); }
  }

  markViewed(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (e) { e.lastViewedAt = Date.now(); e.lastActivityAt = Date.now(); }
  }

  turnStarted(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (e) { e.turnRunning = true; e.lastActivityAt = Date.now(); }
  }

  turnEnded(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    e.turnRunning = false;
    e.lastActivityAt = Date.now();
    this.reevaluate(sessionId);
  }

  releaseSession(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    this.entries.delete(sessionId);
    if (!e.handle.killed) e.handle.kill("SIGTERM");
    this.opts.onCleanup?.(sessionId);
  }

  killAll(): void {
    for (const id of [...this.entries.keys()]) this.releaseSession(id);
  }

  private reevaluate(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    const alive = shouldStayAlive({
      turnRunning: e.turnRunning,
      keepAlive: e.keepAlive,
      cronOrigin: e.cronOrigin,
      lastViewedAt: e.lastViewedAt,
      now: Date.now(),
      graceWindowMs: this.opts.graceWindowMs,
    });
    if (!alive) this.releaseSession(sessionId);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, e] of [...this.entries.entries()]) {
      if (now - e.lastActivityAt > this.opts.idleTimeoutMs) {
        this.releaseSession(id);
        continue;
      }
      this.reevaluate(id);
    }
  }

  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.killAll();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/cuttlefish/src/engines/pty-lifecycle.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cuttlefish/src/engines/pty-lifecycle.ts packages/cuttlefish/src/engines/pty-lifecycle.test.ts
git commit -m "feat(engine): PtyLifecycleManager keyed on session.id"
```

---

## Phase 4 - InteractiveClaudeEngine

### Task 4.1: Transcript tailer

**Files:**
- Create: `packages/cuttlefish/src/engines/transcript-tail.ts`
- Test: `packages/cuttlefish/src/engines/transcript-tail.test.ts`

Parses JSONL lines into `StreamDelta`. The tailer's *parsing* is pure and testable; the *file watching* wraps `fs.watch` + incremental read.

- [ ] **Step 1: Write the failing test** for the line parser:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { parseTranscriptLine } from "./transcript-tail.js";

test("parses an assistant text block into text + text_snapshot deltas", () => {
  const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } });
  const deltas = parseTranscriptLine(line, "");
  assert.deepEqual(deltas.map((d) => d.type), ["text", "text_snapshot"]);
  assert.equal(deltas[0].content, "Hello");
  assert.equal(deltas[1].content, "Hello");
});

test("accumulates text_snapshot across multiple assistant lines", () => {
  const l1 = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello " }] } });
  const l2 = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "world" }] } });
  const d1 = parseTranscriptLine(l1, "");
  const d2 = parseTranscriptLine(l2, d1[1].content);
  assert.equal(d2[1].content, "Hello world");
});

test("parses a tool_use block", () => {
  const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: "t1" }] } });
  const deltas = parseTranscriptLine(line, "");
  assert.equal(deltas[0].type, "tool_use");
  assert.equal(deltas[0].toolName, "Bash");
});

test("parses a tool_result inside a user message", () => {
  const line = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } });
  const deltas = parseTranscriptLine(line, "");
  assert.equal(deltas[0].type, "tool_result");
});

test("ignores metadata lines and unparseable lines", () => {
  assert.deepEqual(parseTranscriptLine(JSON.stringify({ type: "custom-title" }), ""), []);
  assert.deepEqual(parseTranscriptLine("{not json", ""), []);
  assert.deepEqual(parseTranscriptLine("", ""), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/cuttlefish/src/engines/transcript-tail.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement**

```ts
import fs from "node:fs";
import type { StreamDelta } from "../shared/types.js";

/**
 * Parse one transcript JSONL line into StreamDeltas.
 * `priorSnapshot` is the accumulated assistant text so far; the returned
 * text_snapshot delta (if any) contains priorSnapshot + this line's text.
 */
export function parseTranscriptLine(line: string, priorSnapshot: string): StreamDelta[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let msg: any;
  try { msg = JSON.parse(trimmed); } catch { return []; }

  const out: StreamDelta[] = [];
  const content = msg?.message?.content;
  if (!Array.isArray(content)) return out;

  if (msg.type === "assistant") {
    let text = "";
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") text += block.text;
      else if (block.type === "tool_use") {
        out.push({ type: "tool_use", content: `Using ${block.name ?? "tool"}`, toolName: String(block.name ?? "tool"), toolId: String(block.id ?? "") });
      }
    }
    if (text) {
      out.push({ type: "text", content: text });
      out.push({ type: "text_snapshot", content: priorSnapshot + text });
    }
  } else if (msg.type === "user") {
    for (const block of content) {
      if (block.type === "tool_result") out.push({ type: "tool_result", content: "" });
    }
  }
  return out;
}

export interface TranscriptTailer {
  stop(): void;
}

/** Tail a transcript file, emitting StreamDeltas for each appended line. */
export function tailTranscript(filePath: string, onDelta: (d: StreamDelta) => void): TranscriptTailer {
  let offset = 0;
  let snapshot = "";
  let buf = "";
  let stopped = false;

  const readNew = () => {
    if (stopped) return;
    let stat: fs.Stats;
    try { stat = fs.statSync(filePath); } catch { return; }
    if (stat.size <= offset) return;
    const fd = fs.openSync(filePath, "r");
    try {
      const chunk = Buffer.alloc(stat.size - offset);
      fs.readSync(fd, chunk, 0, chunk.length, offset);
      offset = stat.size;
      buf += chunk.toString("utf-8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) {
        for (const d of parseTranscriptLine(l, snapshot)) {
          if (d.type === "text_snapshot") snapshot = d.content;
          onDelta(d);
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  };

  let watcher: fs.FSWatcher | undefined;
  try { watcher = fs.watch(filePath, () => readNew()); } catch { /* file may not exist yet */ }
  const poll = setInterval(readNew, 150); // 100ms batched writes - poll a bit slower
  if (poll.unref) poll.unref();
  readNew();

  return {
    stop() {
      stopped = true;
      watcher?.close();
      clearInterval(poll);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/cuttlefish/src/engines/transcript-tail.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cuttlefish/src/engines/transcript-tail.ts packages/cuttlefish/src/engines/transcript-tail.test.ts
git commit -m "feat(engine): transcript JSONL tailer + line parser"
```

### Task 4.2: Build the interactive `claude` arg list (pure)

**Files:**
- Create: `packages/cuttlefish/src/engines/interactive-args.ts`
- Test: `packages/cuttlefish/src/engines/interactive-args.test.ts`

**[SPIKE-DEP]** Adjust the flag list per Task 0.2 findings (`--effort`/`--chrome` interactive compatibility; system prompt via settings file vs argv).

- [ ] **Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildInteractiveArgs } from "./interactive-args.js";

test("fresh session: prompt is positional, before --mcp-config", () => {
  const args = buildInteractiveArgs({
    prompt: "hi", settingsPath: "/s.json", model: "opus",
    effortLevel: "high", mcpConfigPath: "/m.json", cliFlags: ["--foo"],
  });
  assert.ok(args.includes("hi"));
  assert.ok(!args.includes("--resume"));
  assert.ok(args.includes("--chrome"));
  assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), ["--effort", "high"]);
  assert.ok(args.indexOf("hi") < args.indexOf("--mcp-config"));
  assert.ok(args.includes("--foo"));
});

test("resume session: --resume <id> precedes the positional prompt", () => {
  const args = buildInteractiveArgs({ prompt: "next", settingsPath: "/s.json", resumeSessionId: "abc" });
  assert.ok(args.indexOf("--resume") < args.indexOf("abc"));
  assert.ok(args.indexOf("abc") < args.indexOf("next"));
});

test("effort 'default' is omitted", () => {
  const args = buildInteractiveArgs({ prompt: "hi", settingsPath: "/s.json", effortLevel: "default" });
  assert.ok(!args.includes("--effort"));
});

test("attachments are appended to the prompt text", () => {
  const args = buildInteractiveArgs({ prompt: "look", settingsPath: "/s.json", attachments: ["/a.png"] });
  const promptArg = args.find((a) => a.startsWith("look"));
  assert.match(promptArg!, /Attached files:\n- \/a\.png/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/cuttlefish/src/engines/interactive-args.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement**

```ts
export interface InteractiveArgsOpts {
  prompt: string;
  settingsPath: string;
  resumeSessionId?: string;
  model?: string;
  effortLevel?: string;
  mcpConfigPath?: string;
  cliFlags?: string[];
  attachments?: string[];
}

export function buildInteractiveArgs(o: InteractiveArgsOpts): string[] {
  const args: string[] = [];
  if (o.resumeSessionId) args.push("--resume", o.resumeSessionId);

  let prompt = o.prompt;
  if (o.attachments?.length) {
    prompt += "\n\nAttached files:\n" + o.attachments.map((a) => `- ${a}`).join("\n");
  }
  args.push(prompt); // positional - MUST precede variadic --mcp-config

  args.push("--chrome");
  if (o.effortLevel && o.effortLevel !== "default") args.push("--effort", o.effortLevel);
  if (o.model) args.push("--model", o.model);
  args.push("--dangerously-skip-permissions");
  args.push("--settings", o.settingsPath);
  if (o.cliFlags?.length) args.push(...o.cliFlags);
  if (o.mcpConfigPath) args.push("--mcp-config", o.mcpConfigPath);
  return args;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/cuttlefish/src/engines/interactive-args.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cuttlefish/src/engines/interactive-args.ts packages/cuttlefish/src/engines/interactive-args.test.ts
git commit -m "feat(engine): interactive claude arg-list builder with flag parity"
```

### Task 4.3: `InteractiveClaudeEngine`

**Files:**
- Create: `packages/cuttlefish/src/engines/claude-interactive.ts`
- Test: `packages/cuttlefish/src/engines/claude-interactive.test.ts`

This is the integration core. It implements `InterruptibleEngine`. It is **constructed with** a `PtyLifecycleManager`, a `HookRegistry`, and config (timeouts, paths, hook secret indirectly via gateway.json). Real `node-pty` spawning makes parts of this manually-tested; the **turn-completion contract** (resolver state machine) is unit-tested with injected fakes.

- [ ] **Step 1: Read `packages/cuttlefish/src/engines/claude.ts:32-104` and `packages/cuttlefish/src/shared/types.ts:10-58`** to confirm the `InterruptibleEngine` / `EngineRunOpts` / `EngineResult` shapes the new engine must satisfy.

- [ ] **Step 2: Write the failing test** for the turn-completion state machine. Extract it as a testable class `TurnResolver`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { TurnResolver } from "./claude-interactive.js";

test("TurnResolver resolves only after BOTH SessionStart and Stop", async () => {
  const r = new TurnResolver({ turnTimeoutMs: 1000, fallbackSessionId: "old" });
  let resolved: any;
  r.promise.then((v) => { resolved = v; });
  r.onHook({ hook_event_name: "Stop", last_assistant_message: "done" });
  await new Promise((res) => setTimeout(res, 5));
  assert.equal(resolved, undefined); // Stop alone is not enough
  r.onHook({ hook_event_name: "SessionStart", session_id: "claude-123" });
  await new Promise((res) => setTimeout(res, 5));
  assert.equal(resolved.result, "done");
  assert.equal(resolved.sessionId, "claude-123");
  assert.equal(resolved.numTurns, 1); // synthesized so isDeadSessionError won't false-positive
});

test("TurnResolver settles with an Interrupted error when killed", async () => {
  const r = new TurnResolver({ turnTimeoutMs: 1000, fallbackSessionId: "old" });
  r.onHook({ hook_event_name: "SessionStart", session_id: "c1" });
  r.interrupt("Interrupted: user");
  const v = await r.promise;
  assert.match(v.error, /^Interrupted/);
});

test("TurnResolver settles with an error on watchdog timeout", async () => {
  const r = new TurnResolver({ turnTimeoutMs: 20, fallbackSessionId: "old" });
  const v = await r.promise;
  assert.match(v.error, /timed out/i);
});

test("TurnResolver treats a missing session id as a hard error", async () => {
  const r = new TurnResolver({ turnTimeoutMs: 1000, fallbackSessionId: undefined });
  r.onHook({ hook_event_name: "SessionStart" }); // no session_id
  r.onHook({ hook_event_name: "Stop", last_assistant_message: "x" });
  const v = await r.promise;
  assert.match(v.error, /session id/i);
});

test("TurnResolver settles immediately on StopFailure (does not wait for SessionStart) and exposes it", async () => {
  const r = new TurnResolver({ turnTimeoutMs: 1000, fallbackSessionId: "old" });
  r.onHook({ hook_event_name: "StopFailure", error: "rate_limit", error_details: "resets 3pm" });
  const v = await r.promise;
  assert.match(v.error, /rate_limit/);
  assert.equal(v.numTurns, 1); // so isDeadSessionError won't false-positive
  assert.equal(r.stopFailure?.error, "rate_limit");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx --test packages/cuttlefish/src/engines/claude-interactive.test.ts`
Expected: FAIL - module/class not found.

- [ ] **Step 4: Implement `TurnResolver` + `InteractiveClaudeEngine`.** Full file:

```ts
import * as pty from "node-pty";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InterruptibleEngine, EngineRunOpts, EngineResult, StreamDelta } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { CUTTLEFISH_HOME, CLAUDE_SETTINGS_DIR, HOOK_RELAY_SCRIPT } from "../shared/paths.js";
import { writeSessionSettings } from "../shared/claude-settings.js";
import { buildInteractiveArgs } from "./interactive-args.js";
import { tailTranscript, type TranscriptTailer } from "./transcript-tail.js";
import { PtyLifecycleManager, type PtyHandle } from "./pty-lifecycle.js";
import type { HookRegistry, HookPayload } from "../gateway/hook-registry.js";
// NOTE: cost + rate-limit reconstruction is wired in by Task 5.3 (modifies run()).

export interface TurnResolverOpts { turnTimeoutMs: number; fallbackSessionId: string | undefined; }

/** State machine for one interactive turn: resolves after BOTH SessionStart + Stop, or on interrupt/timeout. */
export class TurnResolver {
  readonly promise: Promise<EngineResult>;
  private resolve!: (r: EngineResult) => void;
  private settled = false;
  private claudeSessionId: string | undefined;
  private gotSessionStart = false;
  private stopPayload: HookPayload | undefined;
  private stopFailurePayload: HookPayload | undefined;
  private timer: NodeJS.Timeout;

  constructor(private opts: TurnResolverOpts) {
    this.promise = new Promise((res) => { this.resolve = res; });
    this.timer = setTimeout(() => this.settle({
      sessionId: opts.fallbackSessionId ?? "",
      result: "",
      error: "Interactive turn timed out (watchdog)",
    }), opts.turnTimeoutMs);
  }

  onHook(h: HookPayload): void {
    if (this.settled) return;
    if (h.hook_event_name === "SessionStart") {
      this.gotSessionStart = true;
      if (typeof h.session_id === "string") this.claudeSessionId = h.session_id;
      this.maybeComplete();
    } else if (h.hook_event_name === "Stop") {
      this.stopPayload = h;
      if (typeof h.session_id === "string" && !this.claudeSessionId) this.claudeSessionId = h.session_id;
      this.maybeComplete();
    } else if (h.hook_event_name === "StopFailure") {
      // API error ended the turn (rate_limit, billing_error, …). Settle immediately
      // with an error - do NOT wait for SessionStart (an early failure may never
      // produce one). numTurns:1 keeps isDeadSessionError from false-positiving.
      this.stopFailurePayload = h;
      if (typeof h.session_id === "string" && !this.claudeSessionId) this.claudeSessionId = h.session_id;
      this.settle({
        sessionId: this.claudeSessionId ?? this.opts.fallbackSessionId ?? "",
        result: "",
        error: `Interactive turn failed: ${h.error ?? "unknown"}`,
        numTurns: 1,
      });
    }
  }

  /** Claude session id learned so far (for engineSessionId persistence on warm-PTY turns). */
  get sessionId(): string | undefined { return this.claudeSessionId; }
  /** The StopFailure payload, if the turn ended in an API error (Task 5.3 maps it to rateLimit). */
  get stopFailure(): HookPayload | undefined { return this.stopFailurePayload; }
  /** transcript_path from whichever hook carried it. */
  get transcriptPath(): string | undefined {
    const p = this.stopPayload?.transcript_path ?? this.stopFailurePayload?.transcript_path;
    return typeof p === "string" ? p : undefined;
  }

  private maybeComplete(): void {
    if (!this.gotSessionStart || !this.stopPayload) return;
    const sid = this.claudeSessionId ?? this.opts.fallbackSessionId;
    if (!sid) {
      this.settle({ sessionId: "", result: "", error: "Interactive turn produced no Claude session id" });
      return;
    }
    const text = String(this.stopPayload.last_assistant_message ?? "");
    this.settle({ sessionId: sid, result: text, error: undefined, numTurns: 1 });
  }

  interrupt(reason: string): void {
    this.settle({ sessionId: this.claudeSessionId ?? this.opts.fallbackSessionId ?? "", result: "", error: reason });
  }

  private settle(r: EngineResult): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.timer);
    this.resolve(r);
  }
}

const CLAUDE_JSON = path.join(os.homedir(), ".claude.json");

export class InteractiveClaudeEngine implements InterruptibleEngine {
  name = "claude" as const;
  /** Active turn resolvers keyed by Cuttlefish session id. */
  private active = new Map<string, { resolver: TurnResolver; tailer?: TranscriptTailer }>();

  constructor(
    private lifecycle: PtyLifecycleManager,
    private hookRegistry: HookRegistry,
    private cfg: { turnTimeoutMs: number },
  ) {}

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const cuttlefishSessionId = opts.sessionId;
    if (!cuttlefishSessionId) throw new Error("InteractiveClaudeEngine.run requires opts.sessionId");

    // Guard: refuse a second concurrent turn for the same session.
    if (this.active.has(cuttlefishSessionId)) {
      return { sessionId: opts.resumeSessionId ?? "", result: "", error: "Interactive engine: a turn is already running for this session" };
    }

    const settingsPath = writeSessionSettings(CLAUDE_SETTINGS_DIR, cuttlefishSessionId, {
      sessionId: cuttlefishSessionId,
      relayScript: HOOK_RELAY_SCRIPT,
      appendSystemPrompt: opts.systemPrompt, // [SPIKE-DEP] argv vs settings - see Task 0.2
    });

    const resolver = new TurnResolver({ turnTimeoutMs: this.cfg.turnTimeoutMs, fallbackSessionId: opts.resumeSessionId });
    const entry: { resolver: TurnResolver; tailer?: TranscriptTailer } = { resolver };
    this.active.set(cuttlefishSessionId, entry);

    // Register BEFORE spawning so a fast SessionStart is buffered+drained, not lost.
    this.hookRegistry.register(cuttlefishSessionId, (h) => {
      resolver.onHook(h);
      if (h.hook_event_name === "SessionStart" && typeof h.transcript_path === "string" && !entry.tailer) {
        entry.tailer = tailTranscript(h.transcript_path, (d) => opts.onStream?.(d));
      }
      if ((h.hook_event_name === "PreToolUse" || h.hook_event_name === "PostToolUse") && opts.onStream) {
        opts.onStream({
          type: h.hook_event_name === "PreToolUse" ? "tool_use" : "tool_result",
          content: String(h.tool_name ?? ""),
          toolName: typeof h.tool_name === "string" ? h.tool_name : undefined,
        });
      }
    });

    const warm = this.lifecycle.getWarm(cuttlefishSessionId);
    if (warm) {
      this.injectPrompt(warm, opts);
      this.lifecycle.turnStarted(cuttlefishSessionId);
    } else {
      const handle = this.spawn(cuttlefishSessionId, opts, settingsPath);
      this.lifecycle.adopt(cuttlefishSessionId, handle, { cronOrigin: opts.source === "cron" });
      this.lifecycle.turnStarted(cuttlefishSessionId);
    }

    let result: EngineResult;
    try {
      result = await resolver.promise;
    } finally {
      entry.tailer?.stop();
      this.hookRegistry.unregister(cuttlefishSessionId);
      this.active.delete(cuttlefishSessionId);
      this.lifecycle.turnEnded(cuttlefishSessionId); // manager decides kill vs keep-warm
    }

    // Task 5.3 inserts cost + rate-limit reconstruction here, using
    // `resolver.transcriptPath`. For now the resolver's result is returned as-is.
    return result;
  }

  /** node-pty spawn of the genuine claude binary (no -p → cc_entrypoint=cli). */
  private spawn(cuttlefishSessionId: string, opts: EngineRunOpts, settingsPath: string): PtyHandle {
    const args = buildInteractiveArgs({
      prompt: opts.prompt,
      settingsPath,
      resumeSessionId: opts.resumeSessionId,
      model: opts.model,
      effortLevel: opts.effortLevel,
      mcpConfigPath: opts.mcpConfigPath,
      cliFlags: opts.cliFlags,
      attachments: opts.attachments,
    });
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
      if (v !== undefined) env[k] = v;
    }
    env.CLAUDE_CODE_NO_FLICKER = "1"; // fullscreen mode - discrete bottom slot for CLI rendering
    const bin = opts.bin || "claude";
    logger.info(`InteractiveClaudeEngine spawning ${bin} (resume: ${opts.resumeSessionId || "none"})`);
    const proc = pty.spawn(bin, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: opts.cwd || CUTTLEFISH_HOME,
      env,
    });
    const handle: PtyHandle = {
      pid: proc.pid,
      get killed() { return (proc as any)._exitCode != null; },
      kill: (signal?: string) => { try { proc.kill(signal); } catch { /* already gone */ } },
    } as PtyHandle;
    proc.onExit(() => {
      // PTY exited without a Stop hook (crash / early exit) - settle as interrupted.
      const e = this.active.get(cuttlefishSessionId);
      e?.resolver.interrupt("Interrupted: claude process exited");
    });
    (handle as any)._proc = proc;
    return handle;
  }

  /** Inject a follow-up prompt into a warm PTY via bracketed-paste + CR. */
  private injectPrompt(handle: PtyHandle, opts: EngineRunOpts): void {
    const proc = (handle as any)._proc as pty.IPty | undefined;
    if (!proc) return;
    let text = opts.prompt;
    if (opts.attachments?.length) {
      text += "\n\nAttached files:\n" + opts.attachments.map((a) => `- ${a}`).join("\n");
    }
    // Phase 0 finding: bracketed-paste does NOT neutralize a leading /, @, or ! -
    // they still trigger the slash-command / mention / bash-mode handlers and the
    // turn is never submitted. Prepend a space so it's treated as a literal message.
    if (/^[/@!]/.test(text)) text = " " + text;
    proc.write(`\x1b[200~${text}\x1b[201~`);
    setTimeout(() => proc.write("\r"), 50); // small delay before submit - see Task 0.1
  }

  kill(sessionId: string, reason = "Interrupted"): void {
    const e = this.active.get(sessionId);
    e?.resolver.interrupt(reason.startsWith("Interrupted") ? reason : `Interrupted: ${reason}`);
    this.lifecycle.releaseSession(sessionId);
  }

  killAll(): void {
    for (const id of [...this.active.keys()]) this.kill(id, "Interrupted: gateway shutting down");
    this.lifecycle.killAll();
  }

  /** True only while a turn is in flight (distinct from "PTY is warm"). */
  isTurnRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /** InterruptibleEngine.isAlive - kept for interface compat; true if a turn OR a warm PTY exists. */
  isAlive(sessionId: string): boolean {
    return this.active.has(sessionId) || this.lifecycle.getWarm(sessionId) !== undefined;
  }
}
```

- [ ] **Step 5: Run the unit test to verify the `TurnResolver` tests pass**

Run: `npx tsx --test packages/cuttlefish/src/engines/claude-interactive.test.ts`
Expected: PASS (4 `TurnResolver` tests). The engine itself is integration-tested in Task 6.5.

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm --filter @cuttlefishcuttlefish-cli typecheck
git add packages/cuttlefish/src/engines/claude-interactive.ts packages/cuttlefish/src/engines/claude-interactive.test.ts
git commit -m "feat(engine): InteractiveClaudeEngine + TurnResolver completion contract"
```

---

## Phase 5 - Cost & rate-limit reconstruction

### Task 5.1: Interactive cost reconstruction

**Files:**
- Create: `packages/cuttlefish/src/engines/interactive-cost.ts`
- Test: `packages/cuttlefish/src/engines/interactive-cost.test.ts`

**[SPIKE-DEP]** Implementation depends on Task 0.3. The code below assumes transcript `assistant` lines carry `message.usage` with `input_tokens`/`output_tokens`/`cache_*`. If Task 0.3 found that unreliable, swap the source to `~/.claude.json` `lastCost`, OR if NO source is reliable: `computeInteractiveCost` returns `null` and a startup warning is logged (handled in Task 6.x) - and budget enforcement is documented as disabled in interactive mode.

- [ ] **Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sumTranscriptUsage, computeInteractiveCost } from "./interactive-cost.js";

test("sumTranscriptUsage sums usage across assistant lines", () => {
  const lines = [
    JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 100, output_tokens: 50 } } }),
    JSON.stringify({ type: "user", message: { content: [] } }),
    JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 200, output_tokens: 80 } } }),
  ].join("\n");
  const u = sumTranscriptUsage(lines);
  assert.equal(u.inputTokens, 300);
  assert.equal(u.outputTokens, 130);
  assert.equal(u.assistantTurns, 2);
});

test("sumTranscriptUsage dedupes assistant lines sharing a message.id (effort-high thinking+text split)", () => {
  // Phase 0 finding: --effort high emits TWO assistant lines per API response -
  // one with the thinking block, one with the text block - same message.id, same usage.
  const lines = [
    JSON.stringify({ type: "assistant", message: { id: "m1", usage: { input_tokens: 100, output_tokens: 50 } } }),
    JSON.stringify({ type: "assistant", message: { id: "m1", usage: { input_tokens: 100, output_tokens: 50 } } }),
    JSON.stringify({ type: "assistant", message: { id: "m2", usage: { input_tokens: 200, output_tokens: 80 } } }),
  ].join("\n");
  const u = sumTranscriptUsage(lines);
  assert.equal(u.inputTokens, 300);
  assert.equal(u.outputTokens, 130);
  assert.equal(u.assistantTurns, 2);
});

test("computeInteractiveCost returns null for a missing transcript", () => {
  assert.equal(computeInteractiveCost("/nope/x.jsonl", "opus"), null);
});

test("computeInteractiveCost produces a non-negative cost from a real transcript file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-"));
  const f = path.join(dir, "t.jsonl");
  fs.writeFileSync(f, JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 1000, output_tokens: 500 } } }));
  const c = computeInteractiveCost(f, "claude-opus-4-7");
  assert.ok(c && c.cost >= 0 && c.turns >= 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/cuttlefish/src/engines/interactive-cost.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement.** Read `packages/cuttlefish/src/gateway/costs.ts` and look for an existing per-model price table; if one exists, import it. If not, define a minimal `MODEL_PRICES` map here (input/output $/Mtok) with a conservative default.

```ts
import fs from "node:fs";

export interface TranscriptUsage { inputTokens: number; outputTokens: number; cacheTokens: number; assistantTurns: number; }

export function sumTranscriptUsage(content: string): TranscriptUsage {
  const u: TranscriptUsage = { inputTokens: 0, outputTokens: 0, cacheTokens: 0, assistantTurns: 0 };
  const seen = new Set<string>();
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let msg: any;
    try { msg = JSON.parse(t); } catch { continue; }
    if (msg.type !== "assistant") continue;
    const usage = msg?.message?.usage;
    if (!usage) continue;
    // Phase 0 finding: --effort high emits two assistant lines per response
    // (thinking + text) with the same message.id and identical usage. Dedupe
    // by message.id so tokens aren't double-counted. Lines without an id are
    // always counted (can't dedupe what we can't key).
    const id = msg?.message?.id;
    if (typeof id === "string") {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    u.assistantTurns += 1;
    u.inputTokens += Number(usage.input_tokens ?? 0);
    u.outputTokens += Number(usage.output_tokens ?? 0);
    u.cacheTokens += Number(usage.cache_read_input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0);
  }
  return u;
}

// $/million tokens. Conservative defaults; refine from gateway/costs.ts if a table exists there.
const MODEL_PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-4-7": { in: 15, out: 75 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};
const DEFAULT_PRICE = { in: 15, out: 75 };

export function computeInteractiveCost(transcriptPath: string, model?: string): { cost: number; turns: number } | null {
  let content: string;
  try { content = fs.readFileSync(transcriptPath, "utf-8"); } catch { return null; }
  const u = sumTranscriptUsage(content);
  if (u.assistantTurns === 0) return null;
  const price = (model && MODEL_PRICES[model]) || DEFAULT_PRICE;
  const cost = (u.inputTokens / 1_000_000) * price.in + (u.outputTokens / 1_000_000) * price.out;
  return { cost, turns: u.assistantTurns };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/cuttlefish/src/engines/interactive-cost.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cuttlefish/src/engines/interactive-cost.ts packages/cuttlefish/src/engines/interactive-cost.test.ts
git commit -m "feat(engine): reconstruct per-turn cost from the transcript"
```

### Task 5.2: Rate-limit mapping from the `StopFailure` hook

**Files:**
- Create: `packages/cuttlefish/src/engines/interactive-ratelimit.ts`
- Test: `packages/cuttlefish/src/engines/interactive-ratelimit.test.ts`

Phase 0 resolved the source: the rate-limit signal is the **`StopFailure` hook** payload's `error` enum (`rate_limit | authentication_failed | billing_error | invalid_request | server_error | max_output_tokens | unknown`) - `StopFailure` fires *instead of* `Stop` when an API error ends the turn. NOT transcript scanning. This module is a pure mapping from a `StopFailure` payload to `EngineRateLimitInfo`, shaped exactly like what `ClaudeEngine` produces from `rate_limit_event` JSON, so the existing `detectRateLimit` / wait-retry-fallback machinery in `manager.ts` and `api.ts` works unchanged. (`TurnResolver` already captures the `StopFailure` payload - Task 4.3; this maps it; Task 5.3 wires it into `run()`.)

- [ ] **Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { rateLimitFromStopFailure } from "./interactive-ratelimit.js";

test("rateLimitFromStopFailure maps a rate_limit error to a rejected EngineRateLimitInfo", () => {
  const info = rateLimitFromStopFailure({ hook_event_name: "StopFailure", error: "rate_limit", error_details: "resets 3pm" });
  assert.equal(info?.status, "rejected");
  assert.equal(info?.rateLimitType, "interactive_detected");
});

test("rateLimitFromStopFailure returns null for a non-rate-limit StopFailure error", () => {
  assert.equal(rateLimitFromStopFailure({ hook_event_name: "StopFailure", error: "server_error" }), null);
  assert.equal(rateLimitFromStopFailure({ hook_event_name: "StopFailure", error: "billing_error" }), null);
});

test("rateLimitFromStopFailure returns null for non-StopFailure / missing error / undefined", () => {
  assert.equal(rateLimitFromStopFailure({ hook_event_name: "Stop" }), null);
  assert.equal(rateLimitFromStopFailure({ hook_event_name: "StopFailure" }), null);
  assert.equal(rateLimitFromStopFailure(undefined), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/cuttlefish/src/engines/interactive-ratelimit.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement**

```ts
import type { EngineRateLimitInfo } from "../shared/types.js";
import type { HookPayload } from "../gateway/hook-registry.js";

/**
 * Map a StopFailure hook payload to an EngineRateLimitInfo.
 * Returns null unless the turn failed specifically with error === "rate_limit".
 * The shape matches what ClaudeEngine produces from `rate_limit_event` JSON, so
 * detectRateLimit() / the wait-retry machinery in manager.ts work unchanged.
 * (error_details may carry a reset time, but its format is unconfirmed - left
 * unparsed; manager.ts computes a default backoff when resetsAt is absent.)
 */
export function rateLimitFromStopFailure(payload: HookPayload | undefined): EngineRateLimitInfo | null {
  if (!payload || payload.hook_event_name !== "StopFailure") return null;
  if (payload.error !== "rate_limit") return null;
  return { status: "rejected", rateLimitType: "interactive_detected" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/cuttlefish/src/engines/interactive-ratelimit.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cuttlefish/src/engines/interactive-ratelimit.ts packages/cuttlefish/src/engines/interactive-ratelimit.test.ts
git commit -m "feat(engine): map StopFailure hook to EngineRateLimitInfo"
```

### Task 5.3: Wire cost & rate-limit reconstruction into `InteractiveClaudeEngine`

**Files:**
- Modify: `packages/cuttlefish/src/engines/claude-interactive.ts` (the import block + the end of `run()`)

- [ ] **Step 1: Add the imports.** In `claude-interactive.ts`, replace the `// NOTE: cost + rate-limit ...` comment with:

```ts
import { computeInteractiveCost } from "./interactive-cost.js";
import { rateLimitFromStopFailure } from "./interactive-ratelimit.js";
```

- [ ] **Step 2: Add reconstruction at the end of `run()`.** Replace the `// Task 5.3 inserts ...` comment + `return result;` with:

```ts
    // Reconstruct cost from the transcript (the Stop hook carries no cost).
    const transcriptPath = resolver.transcriptPath;
    if (transcriptPath && !result.error) {
      const cost = computeInteractiveCost(transcriptPath, opts.model);
      if (cost) { result.cost = cost.cost; result.numTurns = cost.turns; }
    }
    // Map a StopFailure rate-limit into result.rateLimit so manager.ts's
    // wait/retry/fallback machinery engages exactly as it does for `claude -p`.
    const rl = rateLimitFromStopFailure(resolver.stopFailure);
    if (rl) result.rateLimit = rl;
    return result;
  }
```

- [ ] **Step 3: Typecheck.** `pnpm --filter @cuttlefishcuttlefish-cli typecheck` - clean (the modules from 5.1/5.2 now resolve).

- [ ] **Step 4: Run the engine's unit test** to confirm no regression: `npx tsx --test packages/cuttlefish/src/engines/claude-interactive.test.ts` - PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cuttlefish/src/engines/claude-interactive.ts
git commit -m "feat(engine): wire cost + rate-limit reconstruction into run()"
```

---

## Phase 6 - Wire up the daemon

### Task 6.1: Boot wiring - engine selection, gateway.json, hook relay, trust

**Files:**
- Modify: `packages/cuttlefish/src/gateway/server.ts` (engine construction ~`:133`, `ApiContext` ~`:157`, cleanup ~`:738-760`)
- Modify: `packages/cuttlefish/src/gateway/api.ts` (`ApiContext` type - add `hookRegistry`, `hookSecret`)

- [ ] **Step 1: Read `gateway/server.ts:120-200` and `:730-770`** to find where `ClaudeEngine` is constructed, where `ApiContext` is assembled, and the `cleanup()` shutdown closure.

- [ ] **Step 2: Add `hookRegistry` + `hookSecret` to `ApiContext`** in `api.ts`'s context interface.

- [ ] **Step 3: In `server.ts` boot**, after config load:

```ts
import { normalizeClaudeEngineConfig } from "../shared/config.js";
import { writeGatewayInfo } from "./gateway-info.js";
import { HookRegistry } from "./hook-registry.js";
import { PtyLifecycleManager } from "../engines/pty-lifecycle.js";
import { InteractiveClaudeEngine } from "../engines/claude-interactive.js";
import { seedTrust, cleanupSessionSettings } from "../shared/claude-settings.js";
import { GATEWAY_INFO_FILE, HOOK_RELAY_SCRIPT, CUTTLEFISH_HOME, CLAUDE_SETTINGS_DIR } from "../shared/paths.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const claudeCfg = normalizeClaudeEngineConfig(config.engines.claude);
const gatewayInfo = writeGatewayInfo(GATEWAY_INFO_FILE, { port: config.gateway.port, pid: process.pid });
const hookRegistry = new HookRegistry();

let claudeEngine;
if (claudeCfg.mode === "interactive") {
  // copy the hook-relay script into CUTTLEFISH_HOME (idempotent)
  fs.copyFileSync(path.join(import.meta.dirname, "../../assets/hook-relay.mjs"), HOOK_RELAY_SCRIPT);
  seedTrust(path.join(os.homedir(), ".claude.json"), CUTTLEFISH_HOME);
  const lifecycle = new PtyLifecycleManager({
    graceWindowMs: claudeCfg.graceWindowMs,
    idleTimeoutMs: claudeCfg.idleTimeoutMs,
    maxLivePtys: claudeCfg.maxLivePtys,
    onCleanup: (id) => { cleanupSessionSettings(CLAUDE_SETTINGS_DIR, id); hookRegistry.unregister(id); },
  });
  claudeEngine = new InteractiveClaudeEngine(lifecycle, hookRegistry, { turnTimeoutMs: claudeCfg.turnTimeoutMs });
  logger.info("Claude engine: INTERACTIVE mode (PTY, bills as cc_entrypoint=cli)");
} else {
  claudeEngine = new ClaudeEngine(); // existing
  logger.info("Claude engine: headless mode (claude -p)");
}
```

- [ ] **Step 4: Put `hookRegistry` + `gatewayInfo.secret` on `ApiContext`** when it's assembled.

- [ ] **Step 5: In `cleanup()`**, ensure `claudeEngine.killAll()` runs (it already does via the engines map - confirm the interactive engine is in that map) and delete `GATEWAY_INFO_FILE`.

- [ ] **Step 6: Typecheck + manual boot test.** `pnpm --filter @cuttlefishcuttlefish-cli build && CUTTLEFISH_HOME=~/.cuttlefish node packages/cuttlefish/dist/bin/cuttlefish.js start` with `engines.claude.mode: interactive` in config - confirm the log says "INTERACTIVE mode", `~/.cuttlefish/gateway.json` exists with a `secret`, `~/.cuttlefish/hook-relay.mjs` exists, and `~/.claude.json` has the CUTTLEFISH_HOME trust entry. Stop the gateway; confirm `gateway.json` is removed.

- [ ] **Step 7: Commit**

```bash
pnpm --filter @cuttlefishcuttlefish-cli typecheck
git add packages/cuttlefish/src/gateway/server.ts packages/cuttlefish/src/gateway/api.ts
git commit -m "feat(gateway): boot wiring for interactive engine (gateway.json, trust, relay)"
```

### Task 6.2: Hook endpoint → resolver delivery (verify integration)

**Files:**
- Modify: `packages/cuttlefish/src/gateway/api.ts` (the route block from Task 2.4 - confirm it reads `context.hookRegistry` / `context.hookSecret`)

- [ ] **Step 1: Confirm the route block** added in Task 2.4 references the now-populated `context.hookRegistry` and `context.hookSecret`. Fix any reference.

- [ ] **Step 2: Manual end-to-end smoke.** With the interactive gateway running, `curl -s -X POST localhost:8888/api/internal/hook -H "x-cuttlefish-hook-secret: $(jq -r .secret ~/.cuttlefish/gateway.json)" -H 'content-type: application/json' -d '{"cuttlefishSessionId":"nope","hook":{"hook_event_name":"Stop"}}'` → expect `200 {"ok":true}`. Then same `curl` with a wrong secret → expect `403`.

- [ ] **Step 3: Commit** (only if Step 1 required a change)

```bash
git add packages/cuttlefish/src/gateway/api.ts
git commit -m "fix(gateway): wire hook endpoint to populated context"
```

### Task 6.3: `releaseSession` wiring - delete / reset / engine-change / org-change

**Files:**
- Modify: `packages/cuttlefish/src/gateway/api.ts` (`:446`, `:464`, `:479`, `:609`, `:777` - the `isAlive`→`kill` call sites)
- Modify: `packages/cuttlefish/src/sessions/manager.ts` (`resetSession` ~`:835`; the `engineOverride` swap ~`:40-101`)
- Modify: `packages/cuttlefish/src/gateway/server.ts` (`onOrgChange` handler)

- [ ] **Step 1: Read each of the five `api.ts` call sites** that do `if (isInterruptibleEngine(engine) && engine.isAlive(id)) engine.kill(id)`. For DELETE / reset / batch-delete, change them to **always** call `engine.kill(id)` (the interactive `kill()` is a no-op-safe `releaseSession` + resolver-settle; the headless `kill()` already no-ops when not alive). For interrupt-on-new-message (`:777`), gate on `isTurnRunning` if the engine exposes it (feature-detect: `"isTurnRunning" in engine`), else fall back to `isAlive`.

- [ ] **Step 2: Fix `SessionManager.resetSession`** (`manager.ts:835`) - it currently calls `deleteSession` but never kills the engine process. Add: if the engine is interruptible, `engine.kill(session.id, "Interrupted: session reset")` before `deleteSession`.

- [ ] **Step 3: Engine-override swap** - in `manager.ts`'s `maybeRevertEngineOverride` and the rate-limit fallback that swaps `session.engine` to `codex`, call `claudeEngine.kill(session.id, "Interrupted: engine switched")` so the orphaned warm Claude PTY is released.

- [ ] **Step 4: `onOrgChange`** in `server.ts` - after rescanning employees, for any session whose employee's persona/`cliFlags` changed, call `claudeEngine.kill(session.id, "Interrupted: employee config changed")`. (Simplest correct version: kill all warm PTYs on any org change - persona changes are rare. Document this choice in a comment.)

- [ ] **Step 5: Typecheck + manual test.** Interactive gateway running; start a web session, then DELETE it via `curl -X DELETE localhost:8888/api/sessions/<id>` - confirm the `claude` PTY process is gone (`pgrep -f claude`).

- [ ] **Step 6: Commit**

```bash
pnpm --filter @cuttlefishcuttlefish-cli typecheck
git add packages/cuttlefish/src/gateway/api.ts packages/cuttlefish/src/sessions/manager.ts packages/cuttlefish/src/gateway/server.ts
git commit -m "feat: route session teardown through releaseSession; fix resetSession engine kill"
```

### Task 6.4: Settings-file lifecycle - stop cleaning it in `runSession` finally

**Files:**
- Modify: `packages/cuttlefish/src/sessions/manager.ts:746` (the `cleanupMcpConfigFile` call in `finally`)

- [ ] **Step 1: Read `manager.ts:736-748`** (the `finally` block). The `--settings` file must NOT be cleaned here (a warm PTY needs it across turns). Confirm only `cleanupMcpConfigFile` is called here, not any settings-file cleanup. The interactive engine's settings file is cleaned by `PtyLifecycleManager.onCleanup` (wired in Task 6.1) - no change needed here unless a settings cleanup was mistakenly added. Add a code comment noting the settings file is PTY-lifetime, not turn-lifetime.

- [ ] **Step 2: Commit** (if a comment/change was made)

```bash
git add packages/cuttlefish/src/sessions/manager.ts
git commit -m "docs(manager): note --settings file is PTY-lifetime not turn-lifetime"
```

### Task 6.5: End-to-end integration test - interactive turn via connector path

**Files:**
- Test: manual / scripted smoke (no unit test - needs a real `claude`)

- [ ] **Step 1:** Set `engines.claude.mode: interactive` in `~/.cuttlefish/config.yaml`. Build + start the gateway.

- [ ] **Step 2:** POST a web session message: `curl -s -X POST localhost:8888/api/sessions -H 'content-type: application/json' -d '{"prompt":"Reply with exactly E2E_OK"}'`. Capture the `sessionId`.

- [ ] **Step 3:** Poll `GET /api/sessions/<id>` until `status` is `idle`. Confirm the last assistant message is `E2E_OK`, `totalCost` is > 0 (cost reconstruction works), and `engineSessionId` is set (SessionStart id captured).

- [ ] **Step 4:** Send a second message to the same session; confirm it resumes (the assistant has prior context) and `engineSessionId` is unchanged.

- [ ] **Step 5:** Check the Anthropic usage dashboard - confirm the turns counted against **interactive** limits, not the Agent SDK credit. **This is the load-bearing validation of the whole project.**

- [ ] **Step 6:** Record results in the spec's Open Questions section; mark the billing question RESOLVED. Commit the spec update.

```bash
git add docs/superpowers/specs/2026-05-14-interactive-tui-engine-design.md
git commit -m "spike: confirm end-to-end interactive turn bills against interactive limits"
```

---

## Phase 7 - Web UI: Chat ↔ CLI toggle + xterm.js

### Task 7.1: Dedicated `/ws/pty/:sessionId` channel

**Files:**
- Create: `packages/cuttlefish/src/gateway/pty-ws.ts`
- Modify: `packages/cuttlefish/src/gateway/server.ts` (the `upgrade` handler ~`:631`)

- [ ] **Step 1: Read `server.ts:540-640`** - the existing `WebSocketServer`, `wsClients` set, `emit()`, and the `upgrade` handler that accepts only `/ws`.

- [ ] **Step 2: Implement `pty-ws.ts`** - a per-session PTY WebSocket registry. It needs access to the `PtyLifecycleManager` (to get the warm PTY handle's underlying `node-pty` proc) and to the `InteractiveClaudeEngine` (to inject stdin). Expose:

```ts
import type { WebSocketServer, WebSocket } from "ws";
import type { PtyLifecycleManager } from "../engines/pty-lifecycle.js";

export interface PtyWsDeps {
  lifecycle: PtyLifecycleManager;
  /** Inject a completed prompt into the warm PTY (bracketed-paste + CR). */
  injectPrompt: (sessionId: string, text: string) => void;
  /** Resize the warm PTY. */
  resize: (sessionId: string, cols: number, rows: number) => void;
}

/** Handle a /ws/pty/:sessionId upgrade. Streams PTY stdout (binary frames),
 *  accepts {type:"stdin",data} and {type:"resize",cols,rows} upstream,
 *  replays the gateway-side scrollback buffer on connect. */
export function attachPtyWebSocket(ws: WebSocket, sessionId: string, deps: PtyWsDeps): void {
  // 1. find the warm PTY proc via deps.lifecycle.getWarm(sessionId)
  // 2. replay the serialize buffer (kept per session - see Step 3)
  // 3. proc.onData -> ws.send(binary)
  // 4. ws.on("message") -> parse JSON: stdin -> deps.injectPrompt; resize -> deps.resize
  // 5. ws.on("close") -> detach the onData listener (do NOT kill the PTY)
}
```

Implement the body fully: maintain a per-session ring buffer of recent PTY output (cap ~256 KB) so a (re)connecting browser gets a populated terminal; subscribe to the `node-pty` proc's `onData`; forward upstream `stdin`/`resize` messages.

- [ ] **Step 3: Add a scrollback buffer** to the `InteractiveClaudeEngine` spawn path - when a PTY is spawned, attach an `onData` listener that appends to a capped per-session buffer. Expose `getScrollback(sessionId): string` for `pty-ws.ts` to replay.

- [ ] **Step 4: Wire the `upgrade` handler** in `server.ts` - match `/ws/pty/:sessionId`, call `attachPtyWebSocket`. Leave the existing `/ws` path untouched.

- [ ] **Step 5: Typecheck + manual test.** Interactive gateway running; start a session; `websocat ws://localhost:8888/ws/pty/<id>` (or a tiny node ws client) - confirm PTY bytes stream in, and sending `{"type":"stdin","data":"Reply OK"}` injects a turn.

- [ ] **Step 6: Commit**

```bash
pnpm --filter @cuttlefishcuttlefish-cli typecheck
git add packages/cuttlefish/src/gateway/pty-ws.ts packages/cuttlefish/src/gateway/server.ts packages/cuttlefish/src/engines/claude-interactive.ts
git commit -m "feat(gateway): dedicated /ws/pty channel + per-session scrollback buffer"
```

### Task 7.2: Web - `xterm.js` dependency + per-session view-mode persistence

**Files:**
- Modify: `packages/web/package.json`
- Create: `packages/web/src/lib/view-mode.ts`
- Test: `packages/web/src/lib/view-mode.test.ts`

- [ ] **Step 1: Add deps.** `pnpm --filter @cuttlefish/web add @xterm/xterm @xterm/addon-fit @xterm/addon-serialize`.

- [ ] **Step 2: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { viewModeKey, readViewMode, writeViewMode } from "./view-mode.js";

test("viewModeKey is namespaced per session id", () => {
  assert.equal(viewModeKey("s1"), "cuttlefish-view-mode-s1");
});

test("readViewMode defaults to chat for an unknown session", () => {
  const store = new Map<string, string>();
  assert.equal(readViewMode("s1", store), "chat");
});

test("writeViewMode round-trips per session", () => {
  const store = new Map<string, string>();
  writeViewMode("s1", "cli", store);
  writeViewMode("s2", "chat", store);
  assert.equal(readViewMode("s1", store), "cli");
  assert.equal(readViewMode("s2", store), "chat");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx --test packages/web/src/lib/view-mode.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 4: Implement** (a thin localStorage wrapper, injectable store for testing - mirrors the `cuttlefish-<key>-<sessionId>` pattern in `conversations.ts`):

```ts
export type ViewMode = "chat" | "cli";

interface KVStore { getItem(k: string): string | null; setItem(k: string, v: string): void; }

export function viewModeKey(sessionId: string): string {
  return `cuttlefish-view-mode-${sessionId}`;
}

function defaultStore(): KVStore | Map<string, string> {
  return typeof localStorage !== "undefined" ? localStorage : new Map();
}

export function readViewMode(sessionId: string, store: KVStore | Map<string, string> = defaultStore()): ViewMode {
  const raw = store.getItem(viewModeKey(sessionId));
  return raw === "cli" ? "cli" : "chat";
}

export function writeViewMode(sessionId: string, mode: ViewMode, store: KVStore | Map<string, string> = defaultStore()): void {
  store.setItem(viewModeKey(sessionId), mode);
}
```

(Note: `Map` and `Storage` both have `getItem`/`setItem`? `Map` does not - adjust: the helper should accept `Map` and use `.get`/`.set`. Make the store param `{ getItem, setItem }` and in tests pass an adapter, OR accept `Map` and branch. Simplest: accept `Map<string,string>` in tests and `localStorage` in prod, branch on `instanceof Map`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test packages/web/src/lib/view-mode.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/web/package.json packages/web/src/lib/view-mode.ts packages/web/src/lib/view-mode.test.ts pnpm-lock.yaml
git commit -m "feat(web): xterm.js deps + per-session view-mode persistence helper"
```

### Task 7.3: Web - `CliTerminal` component (xterm.js + overlay textarea)

**Files:**
- Create: `packages/web/src/components/cli-terminal.tsx`

- [ ] **Step 1: Read `packages/web/src/lib/ws.ts` and `packages/web/src/hooks/use-gateway.ts`** to match the WebSocket URL/connection conventions.

- [ ] **Step 2: Implement `CliTerminal`** - a React component that:
  - Mounts an `xterm.js` `Terminal` with the `fit` addon into a container ref.
  - Opens `ws://<host>/ws/pty/<sessionId>`, writes incoming binary frames to the terminal.
  - On resize (fit addon), sends `{type:"resize",cols,rows}` upstream.
  - Renders a native `<textarea>` absolutely positioned over the bottom ~6 rows of the terminal (CSS overlay) - the user types here; on submit, sends `{type:"stdin",data:<text>}` and clears the textarea.
  - On unmount, closes the WS (does NOT kill the PTY - the lifecycle manager owns that).

```tsx
"use client";
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export function CliTerminal({ sessionId, wsBase }: { sessionId: string; wsBase: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const term = new Terminal({ convertEol: true, fontSize: 13, theme: { background: "#0b0b0c" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current!);
    fit.fit();
    termRef.current = term;

    const ws = new WebSocket(`${wsBase}/ws/pty/${sessionId}`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    ws.onmessage = (e) => term.write(new Uint8Array(e.data as ArrayBuffer));
    ws.onopen = () => ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));

    const onResize = () => {
      fit.fit();
      ws.readyState === WebSocket.OPEN &&
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      ws.close();
      term.dispose();
    };
  }, [sessionId, wsBase]);

  const onSend = (text: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && text.trim()) {
      ws.send(JSON.stringify({ type: "stdin", data: text }));
    }
  };

  return (
    <div style={{ position: "relative", height: "100%" }}>
      <div ref={containerRef} style={{ height: "100%" }} />
      <CliOverlayInput onSend={onSend} />
    </div>
  );
}

function CliOverlayInput({ onSend }: { onSend: (t: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <textarea
      ref={ref}
      placeholder="Type a message…"
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          onSend(ref.current!.value);
          ref.current!.value = "";
        }
      }}
      style={{
        position: "absolute", left: 0, right: 0, bottom: 0, height: "5.5rem",
        background: "#0b0b0c", color: "#eee", border: "1px solid #333",
        padding: "0.5rem", fontFamily: "monospace", resize: "none",
      }}
    />
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/cli-terminal.tsx
git commit -m "feat(web): CliTerminal - xterm.js view with overlay input"
```

### Task 7.4: Web - wire the toggle, replace `CliTranscript`, persist per-session

**Files:**
- Modify: `packages/web/src/app/chat/page.tsx` (`viewMode` state ~`:106`, the reset-on-switch logic ~`:206`,`:376`, `handleSelect`, `toolbarActions` ~`:441-466`)
- Modify: `packages/web/src/components/chat-pane.tsx` (the `viewMode === 'cli'` branch ~`:591` rendering `CliTranscript`)

- [ ] **Step 1: Read `chat/page.tsx` around the `viewMode` usages and `chat-pane.tsx:580-600`.**

- [ ] **Step 2: Replace `useState` view mode with the persisted helper.** Initialize `viewMode` from `readViewMode(sessionId)`; on toggle, call `writeViewMode(sessionId, mode)`. **Remove the `setViewMode('chat')` reset-on-switch lines** (`page.tsx:206`, `:376`, the one in `handleSelect`) - instead, on session switch, re-read `readViewMode(newSessionId)`.

- [ ] **Step 3: In `chat-pane.tsx`**, change the `viewMode === 'cli'` branch from `<CliTranscript .../>` to `<CliTerminal sessionId={sessionId} wsBase={wsBase} />`. Keep `CliTranscript` importable as a fallback but no longer the default CLI view.

- [ ] **Step 4: Manual test in the browser.** Build the web app, run the interactive gateway. Open a chat, toggle to CLI - confirm the live terminal streams and the overlay textarea sends turns. Switch to another chat and back - confirm the toggle state persisted per session.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/app/chat/page.tsx packages/web/src/components/chat-pane.tsx
git commit -m "feat(web): persist Chat/CLI toggle per session; CLI mode = live xterm.js"
```

### Task 7.5: Web - recently-viewed chat keep-alive cache

**Files:**
- Modify: `packages/web/src/hooks/use-chat-tabs.ts` (add `lastViewedAt` to `ChatTab`)
- Modify: `packages/web/src/app/chat/page.tsx` (render N `ChatPane` instances)

- [ ] **Step 1: Add `lastViewedAt: number` to the `ChatTab` type** in `use-chat-tabs.ts`; set it to `Date.now()` whenever a tab becomes active. Persist it (it's already persisted with tab metadata).

- [ ] **Step 2: In `chat/page.tsx`**, instead of one `<ChatPane>` keyed by the active session, render the **N most-recently-viewed tabs** (by `lastViewedAt`, N=4, < `MAX_TABS`) as mounted `<ChatPane>` instances, with `display:none` on the inactive ones. This keeps their message state and (for CLI mode) the `xterm.js` instance + WS alive across switches.

- [ ] **Step 3: Ensure backgrounded panes don't refetch.** Confirm backgrounded `ChatPane`s rely on the WS delta stream, not `useSession` React Query (which `use-query-invalidation.ts` invalidates on every `session:completed`). If a backgrounded pane subscribes to `useSession`, gate the query `enabled: isActive`.

- [ ] **Step 4: Manual test.** Open 3 chats, switch between them rapidly - confirm switching is instant (no spinner, no re-fetch flash) and CLI terminals retain their scrollback. Confirm after ~5 min idle the warm PTY is released (check `pgrep -f claude`) - this validates the grace window against the lifecycle manager.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/hooks/use-chat-tabs.ts packages/web/src/app/chat/page.tsx
git commit -m "feat(web): keep recently-viewed chats mounted for snappy switching"
```

### Task 7.6: Web - KEEP ALIVE control

**Files:**
- Modify: `packages/web/src/app/chat/page.tsx` (toolbar) + a new `PUT /api/sessions/:id` field
- Modify: `packages/cuttlefish/src/gateway/api.ts` (the `PUT/PATCH /api/sessions/:id` handler)
- Modify: `packages/cuttlefish/src/sessions/registry.ts` (`UpdateSessionFields` - add `keepAlive`; the `Session` type already needs a `keepAlive` column - add a migration)

- [ ] **Step 1: Add a `keep_alive` column** to the `sessions` table via a migration (follow `migrateSessionsSchema` in `registry.ts:159`). Add `keepAlive: boolean` to the `Session` type and `UpdateSessionFields`.

- [ ] **Step 2: In the session update API handler**, when `keepAlive` changes, call the interactive engine's lifecycle: `claudeEngine` exposes `setKeepAlive(sessionId, on)` that forwards to `PtyLifecycleManager.setKeepAlive`. Add that method to `InteractiveClaudeEngine`.

- [ ] **Step 3: Add a KEEP ALIVE toggle** to the chat toolbar in `page.tsx` next to the Chat/CLI toggle; it `PUT`s the session with the new `keepAlive` value.

- [ ] **Step 4: Manual test.** Toggle KEEP ALIVE on for a session, finish a turn, confirm the `claude` PTY stays alive (`pgrep`). Toggle off, finish a turn, confirm it's killed.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter @cuttlefishcuttlefish-cli typecheck
git add packages/cuttlefish/src/sessions/registry.ts packages/cuttlefish/src/gateway/api.ts packages/cuttlefish/src/engines/claude-interactive.ts packages/web/src/app/chat/page.tsx
git commit -m "feat: per-session KEEP ALIVE control (DB column + API + web toggle)"
```

---

## Phase 8 - Fork

### Task 8.1: Route `forkClaudeSession` through the interactive engine

**Files:**
- Modify: `packages/cuttlefish/src/sessions/fork.ts`

- [ ] **Step 1: Read `fork.ts`** in full - note the current `claude --resume <id> --fork-session --print -p …` invocation (`:27`).

- [ ] **Step 2: Change the fork path.** Before forking: if the Claude engine is interactive, call `claudeEngine.kill(sourceSessionId, "Interrupted: forking")` to release any warm PTY holding the source session id (avoids a transcript-file-lock conflict). Then run the fork **without `-p`** in a PTY (so it bills as `cli`) - reuse `buildInteractiveArgs` with `cliFlags: ["--fork-session"]` and no `--mcp-config`/streaming. Capture the new session id from the resulting `SessionStart` hook or from `claude`'s output.

- [ ] **Step 3: If the engine is headless mode**, keep the existing `-p` fork path (it's correct for that mode).

- [ ] **Step 4: Typecheck + manual test.** Interactive mode; fork a session via `POST /api/sessions/:id/duplicate` (or whatever route calls `forkClaudeSession`); confirm the forked session has its own resumable id and the source PTY was released.

- [ ] **Step 5: Commit**

```bash
pnpm --filter @cuttlefishcuttlefish-cli typecheck
git add packages/cuttlefish/src/sessions/fork.ts
git commit -m "feat(fork): interactive-mode fork bills as cli and releases source PTY"
```

---

## Phase 9 - Boot reconciliation & cleanup

### Task 9.1: Orphan-PTY reaping on boot

**Files:**
- Modify: `packages/cuttlefish/src/gateway/server.ts` (boot sequence, near `recoverStaleSessions`)

- [ ] **Step 1: On boot, before writing the fresh `gateway.json`**, read the *old* `gateway.json` if present. For each pid in `ptyPids` (and the old gateway `pid`), if the process is still alive and is a `claude`/relay process, `process.kill(pid, "SIGTERM")`. This reaps PTYs orphaned by a prior crash.

- [ ] **Step 2: Periodically update `gateway.json`'s `ptyPids`** - when the `PtyLifecycleManager` adopts/releases a PTY, call `updateGatewayPtyPids(GATEWAY_INFO_FILE, lifecycle.livePids())`. Wire this via the `onCleanup` callback and an `onAdopt` callback (add one to `PtyLifecycleManager` opts).

- [ ] **Step 3: Manual test.** Start interactive gateway, start a KEEP ALIVE session (PTY warm). `kill -9` the gateway process (simulating a crash). Confirm the `claude` PTY is orphaned (`pgrep -f claude` shows it). Restart the gateway; confirm boot reaps the orphan.

- [ ] **Step 4: Commit**

```bash
git add packages/cuttlefish/src/gateway/server.ts packages/cuttlefish/src/engines/pty-lifecycle.ts
git commit -m "feat(gateway): reap orphaned PTYs on boot via gateway.json pids"
```

### Task 9.2: Full suite + typecheck green

- [ ] **Step 1: Run the full daemon test suite.** `pnpm --filter @cuttlefishcuttlefish-cli test` - all green.
- [ ] **Step 2: Typecheck both packages.** `pnpm typecheck` - clean.
- [ ] **Step 3: Run the existing e2e if present.** `pnpm test:e2e` - no regressions.
- [ ] **Step 4: Final commit** (if any fixes were needed)

```bash
git add -A
git commit -m "test: green suite + typecheck for interactive TUI engine"
```

---

## Self-Review Notes

- **Spec coverage:** every spec component maps to a task - engine (4.3), lifecycle manager (3.1/3.2), hook relay+endpoint (2.1–2.4), transcript tailer (4.1), cost (5.1), rate-limit (5.2), gateway WS (7.1), web Chat/CLI toggle (7.2–7.5), trust seeding (2.1/6.1), config (1.1), fork (8.1), `gateway.json` (1.4/6.1/9.1), KEEP ALIVE (7.6), boot reconciliation (9.1).
- **[SPIKE-DEP] tasks** - 2.1, 4.2, 4.3, 5.1, 5.2 carry assumptions that Phase 0 must confirm; revisit them after the spike before implementing.
- **Type consistency:** `PtyHandle`, `HookPayload`, `HookRegistry`, `TurnResolver`, `PtyLifecycleManager`, `ViewMode` are defined once and reused. `InterruptibleEngine` is satisfied by `InteractiveClaudeEngine` (adds `isTurnRunning`).
- **Manual-test tasks** (4.3 engine spawn, 6.x, 7.x browser, 8.1, 9.1) are integration points that need a real `claude` and/or browser - they have explicit smoke steps rather than unit tests, which is correct for PTY/IO/UI boundaries.
