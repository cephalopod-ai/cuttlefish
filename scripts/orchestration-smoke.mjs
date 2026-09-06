#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const enabled = process.env.CUTTLEFISH_ORCHESTRATION_SMOKE === "1";
if (!enabled) {
  console.log("orchestration smoke skipped: set CUTTLEFISH_ORCHESTRATION_SMOKE=1 to run against a live daemon");
  process.exit(0);
}

const timeoutMs = positiveInt(process.env.CUTTLEFISH_ORCHESTRATION_SMOKE_TIMEOUT_MS, 120_000);
const { baseUrl, token } = resolveGateway();
const taskId = `orchestration-smoke-${Date.now()}`;
const body = {
  mode: "single_worker",
  task: {
    taskId,
    coordinatorId: "smoke-coordinator",
    coordinatorTemplate: process.env.CUTTLEFISH_ORCHESTRATION_SMOKE_TEMPLATE || "standardImplementation",
    prompt: "Smoke test orchestration by reporting readiness only. Do not modify files.",
    ...(process.env.CUTTLEFISH_ORCHESTRATION_SMOKE_CWD ? { cwd: process.env.CUTTLEFISH_ORCHESTRATION_SMOKE_CWD } : {}),
  },
};

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);
try {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/orchestration/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`malformed JSON response (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok && res.status !== 409) {
    throw new Error(`orchestration smoke failed HTTP ${res.status}: ${JSON.stringify(parsed)}`);
  }
  assertStructuredResult(parsed);
  if (parsed.state !== "completed" && parsed.state !== "blocked_resource") {
    throw new Error(`orchestration smoke returned unexpected state ${String(parsed.state)}`);
  }
  console.log(`orchestration smoke ${parsed.state}: ${taskId}`);
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`orchestration smoke failed: ${detail}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
}

/**
 * UPS-A9: this script drives a real gateway. Run from a shell inside a live
 * Cuttlefish session it inherits CUTTLEFISH_HOME / CUTTLEFISH_GATEWAY_URL and
 * aims itself at the operator's own instance without being asked to. The canary
 * below stops that; CUTTLEFISH_ALLOW_PRODUCTION_TARGET=1 is the deliberate
 * opt-out for someone who really does mean their live gateway.
 */
const DEFAULT_GATEWAY_PORTS = [8888];
const allowProductionTarget = process.env.CUTTLEFISH_ALLOW_PRODUCTION_TARGET === "1";

function refuseProductionTarget(reason) {
  if (allowProductionTarget) return;
  throw new Error(
    `Refusing to run the orchestration smoke against what looks like your live Cuttlefish instance (${reason}). ` +
    "Point it at a sandbox instance, or set CUTTLEFISH_ALLOW_PRODUCTION_TARGET=1 if you really mean it.",
  );
}

function resolveGateway() {
  const explicitUrl = process.env.CUTTLEFISH_GATEWAY_URL;
  const explicitToken = process.env.CUTTLEFISH_GATEWAY_TOKEN;
  if (explicitUrl) {
    try {
      const parsed = new URL(explicitUrl);
      const urlPort = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
      if (DEFAULT_GATEWAY_PORTS.includes(urlPort)) {
        refuseProductionTarget(`url ${explicitUrl} targets a default gateway port`);
      }
    } catch {
      // An unparseable URL is the caller's problem, not this canary's.
    }
    return { baseUrl: explicitUrl, token: explicitToken };
  }

  const home = process.env.CUTTLEFISH_HOME || path.join(os.homedir(), ".cuttlefish");
  if (path.resolve(home) === path.join(os.homedir(), ".cuttlefish")) {
    refuseProductionTarget(`home ${path.resolve(home)} is the default instance home`);
  }
  const gatewayPath = path.join(home, "gateway.json");
  const configPath = path.join(home, "config.yaml");
  const info = JSON.parse(fs.readFileSync(gatewayPath, "utf-8"));
  const host = readConfigHost(configPath) || "127.0.0.1";
  const port = info.port;
  if (!port) throw new Error(`gateway info file is missing port: ${gatewayPath}`);
  if (DEFAULT_GATEWAY_PORTS.includes(Number(port))) {
    refuseProductionTarget(`port ${port} is a default gateway port`);
  }
  return {
    baseUrl: `http://${host}:${port}`,
    token: explicitToken || info.apiToken,
  };
}

function readConfigHost(configPath) {
  try {
    const text = fs.readFileSync(configPath, "utf-8");
    const match = text.match(/^\s*host:\s*["']?([^"'\n#]+)["']?\s*$/m);
    return match?.[1]?.trim();
  } catch {
    return null;
  }
}

function assertStructuredResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("orchestration smoke response was not an object");
  }
  if (typeof value.state !== "string" || typeof value.mode !== "string") {
    throw new Error(`orchestration smoke response missing state/mode: ${JSON.stringify(value)}`);
  }
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
