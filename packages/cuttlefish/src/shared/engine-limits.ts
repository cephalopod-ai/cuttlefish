import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  EngineLimitBucket,
  EngineLimitCredits,
  EngineLimitEngineSnapshot,
  EngineLimitWindow,
  EngineLimitsResponse,
  CuttlefishConfig,
} from "./types.js";
import { CLAUDE_LIMITS_DIR } from "./paths.js";
import { getModelRegistry } from "./models.js";
import { resolveBin } from "./resolve-bin.js";

type JsonRecord = Record<string, unknown>;

export interface CollectEngineLimitsOptions {
  engine?: string;
}

const LIVE_LIMIT_ENGINES = new Set(["codex"]);

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function isoFromSeconds(seconds: number | undefined): string | undefined {
  return seconds ? new Date(seconds * 1000).toISOString() : undefined;
}

function limitWindowName(fallback: string, durationMins: number | undefined): string {
  if (durationMins === 300) return "5h";
  if (durationMins === 10_080) return "7d";
  return fallback;
}

function baseSnapshot(config: CuttlefishConfig, engine: string): EngineLimitEngineSnapshot {
  const registry = getModelRegistry(config);
  const entry = registry[engine];
  return {
    name: engine,
    available: entry?.available ?? false,
    status: entry?.available ? "static" : "unsupported",
    source: "model-registry",
    refreshedAt: nowIso(),
    defaultModel: entry?.defaultModel,
    models: entry?.models ?? [],
  };
}

function windowFromClaude(name: string, value: unknown, durationMins: number): EngineLimitWindow | undefined {
  if (!isRecord(value)) return undefined;
  const resetsAt = num(value.resets_at);
  return {
    name,
    usedPercent: num(value.used_percentage),
    windowDurationMins: durationMins,
    resetsAt,
    resetsAtIso: isoFromSeconds(resetsAt),
  };
}

function claudeSnapshotFile(dir: string): string | null {
  try {
    const files = fs.readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(dir, name))
      .map((file) => {
        let hasRateLimits = false;
        try {
          const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
          hasRateLimits = !!parsed?.rate_limits?.five_hour || !!parsed?.rate_limits?.seven_day;
        } catch { /* ignore corrupt snapshots here; collector handles selected file */ }
        return { file, hasRateLimits, mtimeMs: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files.find((f) => f.hasRateLimits)?.file ?? files[0]?.file ?? null;
  } catch {
    return null;
  }
}

async function claudeAuthPlan(config: CuttlefishConfig): Promise<string | undefined> {
  const bin = resolveBin("claude", config.engines.claude?.bin);
  return new Promise((resolve) => {
    execFile(bin, ["auth", "status"], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(undefined);
      try {
        const parsed = JSON.parse(stdout);
        resolve(str(parsed.subscriptionType) ?? str(parsed.authMethod));
      } catch {
        resolve(undefined);
      }
    });
  });
}

async function collectClaudeLimits(config: CuttlefishConfig): Promise<EngineLimitEngineSnapshot> {
  const snap = baseSnapshot(config, "claude");
  if (!snap.available) {
    return { ...snap, status: "unsupported", unsupportedReason: "Claude CLI is not installed." };
  }

  const latest = claudeSnapshotFile(CLAUDE_LIMITS_DIR);
  const accountPlan = await claudeAuthPlan(config);
  if (!latest) {
    return {
      ...snap,
      status: "static",
      source: "claude-statusline",
      accountPlan,
      unsupportedReason: "No Claude statusline snapshot has been captured yet. Run a Claude session to populate live limits.",
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(latest, "utf-8")) as unknown;
    if (!isRecord(parsed)) throw new Error("Snapshot is not a JSON object");
    const rateLimits = isRecord(parsed.rate_limits) ? parsed.rate_limits : {};
    const windows = [
      windowFromClaude("5h", rateLimits.five_hour, 300),
      windowFromClaude("7d", rateLimits.seven_day, 10_080),
    ].filter(Boolean) as EngineLimitWindow[];
    const ctx = isRecord(parsed.context_window) ? parsed.context_window : undefined;
    const cost = isRecord(parsed.cost) ? num(parsed.cost.total_cost_usd) : undefined;
    const stat = fs.statSync(latest);
    const stale = Date.now() - stat.mtimeMs > 30 * 60_000;
    return {
      ...snap,
      status: windows.length > 0 ? "snapshot" : "static",
      source: "claude-statusline",
      refreshedAt: str(parsed.captured_at) ?? new Date(stat.mtimeMs).toISOString(),
      accountPlan,
      windows,
      context: ctx
        ? {
            usedPercent: num(ctx.used_percentage),
            remainingPercent: num(ctx.remaining_percentage),
            contextWindowSize: num(ctx.context_window_size),
            totalInputTokens: num(ctx.total_input_tokens),
            totalOutputTokens: num(ctx.total_output_tokens),
          }
        : undefined,
      costUsd: cost,
      stale,
    };
  } catch (err) {
    return {
      ...snap,
      status: "error",
      source: "claude-statusline",
      accountPlan,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function windowFromCodex(name: string, value: unknown): EngineLimitWindow | undefined {
  if (!isRecord(value)) return undefined;
  const durationMins = num(value.windowDurationMins);
  const resetsAt = num(value.resetsAt);
  return {
    name: limitWindowName(name, durationMins),
    usedPercent: num(value.usedPercent),
    windowDurationMins: durationMins,
    resetsAt,
    resetsAtIso: isoFromSeconds(resetsAt),
  };
}

function creditsFromCodex(value: unknown): EngineLimitCredits | undefined {
  if (!isRecord(value)) return undefined;
  const resetsAt = num(value.resetsAt);
  return {
    hasCredits: typeof value.hasCredits === "boolean" ? value.hasCredits : undefined,
    unlimited: typeof value.unlimited === "boolean" ? value.unlimited : undefined,
    balance: str(value.balance),
    limit: num(value.limit),
    used: num(value.used),
    remainingPercent: num(value.remainingPercent),
    resetsAt,
    resetsAtIso: isoFromSeconds(resetsAt),
  };
}

async function readCodexRateLimits(config: CuttlefishConfig): Promise<JsonRecord> {
  const bin = resolveBin("codex", config.engines.codex?.bin);
  const initialize = {
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "cuttlefish", version: "0" },
      capabilities: { experimentalApi: true },
    },
  };
  const request = { id: 2, method: "account/rateLimits/read", params: null };

  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(stderr.trim() || "Timed out reading Codex rate limits"));
    }, 5000);

    function settle(value: JsonRecord): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve(value);
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (const line of stdout.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        try {
          const msg = JSON.parse(t);
          if (msg?.id === 2) {
            if (msg.error) throw new Error(JSON.stringify(msg.error));
            if (isRecord(msg.result)) settle(msg.result);
          }
        } catch {
          // Ignore partial/non-JSON lines until more data arrives.
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(stderr.trim() || "Codex app-server exited before returning rate limits"));
    });
    child.stdin.write(`${JSON.stringify(initialize)}\n${JSON.stringify(request)}\n`);
    // Keep stdin OPEN until we settle or time out. `codex app-server --stdio`
    // exits as soon as stdin closes, so the previous fixed 1s close timer raced
    // the async rate-limit fetch and made the server exit before replying
    // ("exited before returning rate limits"). settle()/the timeout kill the
    // child for us, so there is no need to close stdin ourselves.
  });
}

function bucketsFromCodex(result: JsonRecord): EngineLimitBucket[] {
  const byId = isRecord(result.rateLimitsByLimitId) ? result.rateLimitsByLimitId : undefined;
  const snapshots: Array<[string, unknown]> = byId
    ? Object.entries(byId)
    : Array.isArray(result.rateLimits)
      ? result.rateLimits.map((item, idx) => [String(idx), item] as [string, unknown])
      : [];

  return snapshots.flatMap(([id, value]) => {
    if (!isRecord(value)) return [];
    const bucketId = str(value.limitId) ?? id;
    return [{
      id: bucketId,
      name: str(value.limitName),
      planType: str(value.planType),
      primary: windowFromCodex("5h", value.primary),
      secondary: windowFromCodex("7d", value.secondary),
      credits: creditsFromCodex(value.credits),
    }];
  });
}

function planWindow(name: string, windowDurationMins: number): EngineLimitWindow {
  return { name, windowDurationMins };
}

// Codex writes the same rate-limit snapshot into every `token_count` event of its
// session rollout JSONL (snake_case), so we can read it from disk exactly like the
// Claude statusline snapshot — no app-server spawn, no JSON-RPC race.
function windowFromCodexRollout(name: string, value: unknown): EngineLimitWindow | undefined {
  if (!isRecord(value)) return undefined;
  const durationMins = num(value.window_minutes);
  const resetsAt = num(value.resets_at);
  return {
    name: limitWindowName(name, durationMins),
    usedPercent: num(value.used_percent),
    windowDurationMins: durationMins,
    resetsAt,
    resetsAtIso: isoFromSeconds(resetsAt),
  };
}

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

// Walk the date-structured sessions/YYYY/MM/DD tree newest-first to the most
// recent rollout file without listing every session.
function newestCodexRollout(sessionsDir: string): string | null {
  try {
    let dir = sessionsDir;
    for (let depth = 0; depth < 3; depth++) {
      const subdirs = fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .reverse();
      if (subdirs.length === 0) return null;
      dir = path.join(dir, subdirs[0]);
    }
    const files = fs.readdirSync(dir)
      .filter((n) => n.startsWith("rollout-") && n.endsWith(".jsonl"))
      .map((n) => path.join(dir, n))
      .map((file) => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files[0]?.file ?? null;
  } catch {
    return null;
  }
}

interface CodexRollup { rateLimits: JsonRecord; capturedAtIso?: string; mtimeMs: number }

function readCodexRollupSnapshot(): CodexRollup | null {
  const file = newestCodexRollout(path.join(codexHome(), "sessions"));
  if (!file) return null;
  try {
    const mtimeMs = fs.statSync(file).mtimeMs;
    const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (!t || !t.includes('"rate_limits"')) continue;
      try {
        const parsed = JSON.parse(t);
        const rl = isRecord(parsed.payload) ? parsed.payload.rate_limits : undefined;
        if (isRecord(rl)) return { rateLimits: rl, capturedAtIso: str(parsed.timestamp), mtimeMs };
      } catch { /* skip non-JSON / partial line */ }
    }
    return null;
  } catch {
    return null;
  }
}

async function collectCodexLimits(config: CuttlefishConfig): Promise<EngineLimitEngineSnapshot> {
  const snap = baseSnapshot(config, "codex");
  if (!snap.available) {
    return { ...snap, status: "unsupported", unsupportedReason: "Codex CLI is not installed." };
  }

  // Primary: latest session rollout snapshot on disk (light, never races).
  const rollup = readCodexRollupSnapshot();
  if (rollup) {
    const rl = rollup.rateLimits;
    const windows = [
      windowFromCodexRollout("5h", rl.primary),
      windowFromCodexRollout("7d", rl.secondary),
    ].filter(Boolean) as EngineLimitWindow[];
    if (windows.length > 0) {
      return {
        ...snap,
        status: "snapshot",
        source: "codex session rollout",
        refreshedAt: rollup.capturedAtIso ?? new Date(rollup.mtimeMs).toISOString(),
        windows,
        accountPlan: str(rl.plan_type),
        stale: Date.now() - rollup.mtimeMs > 30 * 60_000,
      };
    }
  }

  // Fallback: live app-server query, used only when no rollout snapshot exists yet.
  try {
    const result = await readCodexRateLimits(config);
    const buckets = bucketsFromCodex(result);
    const main = buckets.find((b) => b.id === "codex") ?? buckets[0];
    return {
      ...snap,
      status: "live",
      source: "codex app-server account/rateLimits/read",
      windows: [main?.primary, main?.secondary].filter(Boolean) as EngineLimitWindow[],
      buckets,
      credits: main?.credits,
      accountPlan: main?.planType,
    };
  } catch {
    return {
      ...snap,
      status: "static",
      source: "codex session rollout",
      unsupportedReason: "No Codex session rollout with rate limits yet. Run a Codex session to populate live limits.",
    };
  }
}

function collectUnsupported(config: CuttlefishConfig, engine: string, reason: string): EngineLimitEngineSnapshot {
  const snap = baseSnapshot(config, engine);
  return {
    ...snap,
    status: snap.available ? "unsupported" : "unsupported",
    source: "model-registry",
    unsupportedReason: reason,
  };
}

export async function collectEngineLimits(
  config: CuttlefishConfig,
  opts: CollectEngineLimitsOptions = {},
): Promise<EngineLimitsResponse> {
  const registry = getModelRegistry(config);
  const names = opts.engine ? [opts.engine] : Object.keys(registry);
  const generatedAt = nowIso();
  const engines: Record<string, EngineLimitEngineSnapshot> = {};

  for (const name of names) {
    if (!registry[name]) {
      engines[name] = {
        name,
        available: false,
        status: "unsupported",
        source: "model-registry",
        refreshedAt: generatedAt,
        models: [],
        unsupportedReason: "Unknown engine.",
      };
      continue;
    }

    if (name === "claude") {
      engines[name] = await collectClaudeLimits(config);
    } else if (name === "codex") {
      engines[name] = await collectCodexLimits(config);
    } else if (name === "antigravity") {
      const snap = baseSnapshot(config, name);
      engines[name] = {
        ...snap,
        status: snap.available ? "static" : "unsupported",
        source: "agy models + interactive /credits",
        windows: [planWindow("5h", 300), planWindow("7d", 10_080)],
        unsupportedReason: "Antigravity exposes plan windows and G1 credit controls through the interactive `/credits` and `/settings` UI, but no stable non-interactive JSON quota endpoint was found.",
      };
    } else if (name === "pi") {
      engines[name] = collectUnsupported(
        config,
        name,
        "Pi exposes model capabilities and per-session usage, but no aggregate account quota endpoint.",
      );
    } else if (name === "grok") {
      engines[name] = collectUnsupported(
        config,
        name,
        "Grok currently exposes model/session behavior through its CLI, but no stable local quota endpoint is registered.",
      );
    } else if (name === "hermes") {
      engines[name] = collectUnsupported(
        config,
        name,
        "Hermes currently exposes model/session behavior through its CLI, but no stable local quota endpoint is registered.",
      );
    } else {
      engines[name] = collectUnsupported(config, name, "No limit collector is registered for this engine.");
    }

    if (!LIVE_LIMIT_ENGINES.has(name) && engines[name].status === "live") {
      engines[name].status = "snapshot";
    }
  }

  return { generatedAt, default: config.engines.default, engines };
}
