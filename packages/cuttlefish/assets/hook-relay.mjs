#!/usr/bin/env node
// Cuttlefish hook relay. Invoked by Claude Code hooks as: node hook-relay.mjs <cuttlefishSessionId>
// Reads hook JSON on stdin, POSTs to the gateway's /api/internal/hook.
// Most relay failures exit 0 so Claude is not interrupted; policy hard-blocks exit non-zero.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const cuttlefishSessionId = process.argv[2];
const CUTTLEFISH_HOME = process.env.CUTTLEFISH_HOME || path.join(os.homedir(), ".cuttlefish");

function logBestEffort(err) {
  // Best-effort diagnostic log. Never throws — silent failure here is OK
  // because we'd rather lose a log line than block the TUI on exit.
  try {
    const line = `${new Date().toISOString()} ${err?.message ?? err}\n`;
    fs.appendFileSync(path.join(CUTTLEFISH_HOME, "hook-relay.log"), line);
  } catch {}
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let payload;
  try { payload = JSON.parse(raw); } catch (err) { logBestEffort(err); return; }

  let info;
  try { info = JSON.parse(fs.readFileSync(path.join(CUTTLEFISH_HOME, "gateway.json"), "utf-8")); } catch (err) { logBestEffort(err); return; }

  const body = JSON.stringify({ cuttlefishSessionId, hook: payload });
  const response = await fetch(`http://127.0.0.1:${info.port}/api/internal/hook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cuttlefish-hook-secret": info.secret },
    body,
  }).catch((err) => { logBestEffort(err); return null; });
  if (response && response.status === 451) {
    const text = await response.text().catch(() => "Command blocked by Cuttlefish security policy");
    process.stderr.write(text || "Command blocked by Cuttlefish security policy");
    process.exitCode = 2;
  }
}

main().catch((err) => { logBestEffort(err); process.exitCode = process.exitCode || 0; });
