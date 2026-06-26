# `cuttlefish restart` - detached, in-session-safe gateway restart

**Date:** 2026-06-04
**Status:** Approved (design)
**Scope:** Small. One new CLI command + one detached-helper entry point. No architecture changes.

## Problem

Restarting the gateway from *inside* a Cuttlefish chat session (the normal workflow:
"rebuild the web UI and restart the gateway") breaks. Root cause:

- The gateway runs as a daemon. Every chat session is a `claude` PTY **child of
  that daemon**.
- An agent running `cuttlefish stop && cuttlefish start` runs it as a subprocess of its own
  session.
- `cuttlefish stop` sends `SIGTERM` to the daemon (`lifecycle.ts` `stop()`).
- The daemon's shutdown calls `interactiveClaudeEngine.killAll()`
  (`server.ts`), which kills **every** PTY - including the session running the
  command.
- The session dies → the `&& cuttlefish start` half never runs → the gateway stays
  down.

"Sawing off the branch you're sitting on": the restarter is a descendant of the
thing it kills, so `stop` takes the restarter down with it.

## Solution (KISS)

Add a single `cuttlefish restart` command that performs the stop→start from a
**detached, reparented helper process** that is *not* owned by the gateway, so
the gateway's `killAll()` cannot kill it.

This reuses two patterns already in the codebase:
- `startDaemon()`'s detached-fork pattern (`fork(entry, [], {detached:true,
  stdio:"ignore"}); child.disconnect(); child.unref()`) - the helper is
  reparented to launchd and survives its parent's death.
- The gateway's existing **interrupted-session resume** (sessions are marked
  `interrupted` on shutdown; the web client cold-respawns them with `--resume`
  when the gateway returns). This keeps the chat conversation intact across the
  restart - a brief blip, full history preserved.

**`stop` is unchanged.** `start` gets one added guard (see Component 5): if a
gateway is already running, `start` routes to the same race-free restart path
instead of the current racy double-boot. No env detection, no lockfile. Habit:
use `cuttlefish restart` (or just re-run `cuttlefish start`) instead of `cuttlefish stop && cuttlefish
start`.

### Why `start`-before-`stop` is broken today

Running `cuttlefish start` while the gateway is already up is a race that can leave you
fully down:

1. `startDaemon()` forks a new daemon and **immediately overwrites
   `gateway.pid`** with the new PID - before it has proven it can boot.
2. The new daemon's boot-time reap (`server.ts`) sends `SIGTERM` to the **old
   gateway and all its PTYs** (including the calling session).
3. The new daemon then calls `server.listen(port)`. If the old gateway hasn't
   released the port yet (graceful shutdown is up to 5s), the new one hits
   `EADDRINUSE` → `process.exit(1)`.

Net: old gateway killed, new one possibly dead, `gateway.pid` stale. The fix
(Component 5) adds an explicit **wait-for-port-free** gate, exactly as the
detached helper does - eliminating the race for both orderings.

## Components

### 1. `restart-entry.ts` (new) - `packages/cuttlefish/src/gateway/restart-entry.ts`

The detached helper's entry point, modeled on `daemon-entry.ts`. Runs in its own
reparented process:

1. `uncaughtException` / `unhandledRejection` guards (same as `daemon-entry.ts`).
2. `loadConfig()`.
3. `stop()` - SIGTERM the running gateway (best-effort; no-op if already down).
4. `await waitForPortFree(port)` - the shared helper (see Component 5).
5. `startDaemon(config)` - bring up a fresh daemon.
6. Exit 0.

Compiled to `dist/src/gateway/restart-entry.js` (tsc picks it up automatically).

### 2. `restartDetached()` (new) - in `packages/cuttlefish/src/gateway/lifecycle.ts`

Mirrors `startDaemon()`: resolves `restart-entry.js` via the same
candidate-path lookup, forks it detached with `stdio:"ignore"`,
`disconnect()` + `unref()`, passing `CUTTLEFISH_HOME` through the env. Returns
immediately.

### 3. `runRestart()` (new) - `packages/cuttlefish/src/cli/restart.ts`

```
export async function runRestart(opts: { port?: number }): Promise<void> {
  // optional --port override on config, like runStart
  restartDetached(config);
  console.log("Gateway restarting in background (detached). It will be back in a few seconds.");
}
```

### 4. Command registration - `packages/cuttlefish/bin/cuttlefish.ts`

Add alongside `start`/`stop`:

```
program
  .command("restart")
  .description("Restart the gateway (detached - safe to run from inside a session)")
  .option("-p, --port <port>", "Port to start on")
  .action(async (opts) => {
    const { runRestart } = await import("../src/cli/restart.js");
    await runRestart({ port: opts.port ? parseInt(opts.port, 10) : undefined });
  });
```

### 5. `start` already-running guard + `waitForPortFree()` - `lifecycle.ts` + `cli/start.ts`

New shared helper in `lifecycle.ts`:

```
export async function waitForPortFree(port: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (findPidOnPort(port) === null) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false; // timed out; caller starts anyway (startGateway will surface EADDRINUSE)
}
```

`runStart()` gains one guard at the top (after config/port resolution):

```
if (getStatus().running) {
  if (opts.daemon) {
    restartDetached(config);              // race-free detached restart
    console.log("Gateway already running - restarting in background.");
    return;
  }
  // foreground: stop the old one, wait for the port, then fall through to start
  stop(config.gateway.port);
  await waitForPortFree(config.gateway.port);
}
```

So `cuttlefish start` on an already-running gateway becomes a clean restart instead of
the racy double-boot. `stop` and `restart` both reuse `waitForPortFree`.

## Flow after the change

1. Agent (inside a session) runs `cuttlefish restart`.
2. `runRestart` forks the detached helper and exits immediately (0).
3. The gateway tears down sessions, killing the agent's PTY and the `cuttlefish
   restart` foreground process - **but the helper is already reparented and
   unref'd, so it keeps running.**
4. Helper: `stop()` → wait for port free → `startDaemon()` → exit.
5. New gateway boots, resumes interrupted sessions; the web client reconnects
   and the conversation continues.

## Error handling / edge cases

- **Gateway already down:** `stop()` is a no-op (already handles stale PID /
  nothing-on-port); helper proceeds straight to start.
- **Port never frees (timeout):** after ~10s the helper attempts `startDaemon()`
  anyway; if the port is still bound, `startGateway` fails to bind and the
  helper logs + exits non-zero (visible in `~/.cuttlefish/logs`). No worse than today.
- **Helper crashes:** logged via the uncaught-exception guards to the gateway
  log file; the user can re-run `cuttlefish restart` or `cuttlefish start`.

## Out of scope (explicitly not doing)

- Env-var (`CUTTLEFISH_IN_SESSION`) detection to auto-harden naive `stop && start`.
- Lockfile coordination between `stop` and `start` (the `waitForPortFree` gate
  makes it unnecessary).
- Web rebuild folded into the command (`redeploy`).
- Literal PTY survival across restart (PTY-broker architecture).

These were considered and dropped as over-engineering for a dev-convenience fix.

## Replication note

Per ops reality: the live daemon runs from `~/Projects/cuttlefish-sprint` (branch
`integration/engine-sprint-and-file-viewer`), while `~/Projects/cuttlefish` (`main`)
is canonical. The change must be applied to **both** repos, then the daemon
rebuilt + restarted to take effect.

## Testing

- Unit: `restartDetached` forks the expected entry path (mirror any existing
  `startDaemon` test pattern).
- Manual: from inside a session, run `cuttlefish restart`; confirm the gateway goes
  down and comes back and the web UI reconnects/resumes the conversation.
- Manual (terminal): run `cuttlefish restart` from a plain terminal; confirm it
  restarts cleanly with no session attached.
- Manual: run `cuttlefish start -d` while the gateway is already up; confirm it
  cleanly restarts (no `EADDRINUSE`, no stale PID) instead of racing.
