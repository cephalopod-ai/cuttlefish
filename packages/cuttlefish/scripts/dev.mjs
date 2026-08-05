#!/usr/bin/env node
/**
 * Cross-platform dev runner: one blocking tsc build, then `tsc --watch`
 * alongside `node --watch-path=dist dist/bin/cuttlefish.js start`.
 *
 * Replaces the POSIX-only `tsc && (tsc --watch &) && node …` script — cmd.exe
 * cannot parse `( … &)` backgrounding. tsc is invoked through its resolved JS
 * entry so no `.cmd` shim (and therefore no shell) is involved on Windows.
 */
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tsc = require.resolve("typescript/bin/tsc");

const initial = spawnSync(process.execPath, [tsc], { stdio: "inherit" });
if (initial.status !== 0) process.exit(initial.status ?? 1);

const watcher = spawn(process.execPath, [tsc, "--watch", "--preserveWatchOutput"], { stdio: "inherit" });
const daemon = spawn(
  process.execPath,
  ["--watch-path=dist", "dist/bin/cuttlefish.js", "start"],
  { stdio: "inherit" },
);

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of [watcher, daemon]) {
    if (child.exitCode === null) {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
    }
  }
  process.exitCode = code;
}

daemon.on("exit", (code) => stop(code ?? 0));
watcher.on("exit", (code) => { if (code !== null && code !== 0) stop(code); });
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
