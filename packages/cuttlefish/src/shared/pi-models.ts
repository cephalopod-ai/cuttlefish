import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelInfo } from "./types.js";
import { logger } from "./logger.js";

/**
 * Dynamic model discovery for the Pi engine.
 *
 * The gateway asks Pi itself which models exist (`pi --list-models`) rather than
 * reaching into any backend (Ollama, LM Studio, …). We scope the result to the
 * providers the user configured in their Pi `~/.pi/agent/models.json` — i.e. their
 * own local/custom models — and drop Pi's built-in cloud providers, which overlap
 * with the claude/codex engines and may lack credentials.
 *
 * Note: `pi --list-models` reports `thinking` (reasoning) and `images` (vision)
 * capability, but NOT tool-calling. A model that lacks native tool support
 * therefore can't be pre-filtered here — it surfaces a clear runtime error from
 * the engine instead of silently doing nothing.
 */

/** Effort levels exposed for reasoning-capable (thinking) Pi models → `--thinking`. */
const PI_EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh"];

/** "1.0M" / "262.1K" / "16.4K" / "128K" → token count. */
function parseTokens(s: string): number | undefined {
  const m = /^([\d.]+)\s*([KM])?$/i.exec(s.trim());
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = (m[2] || "").toUpperCase();
  const mult = unit === "M" ? 1e6 : unit === "K" ? 1e3 : 1;
  return Math.round(n * mult);
}

/** Provider names configured in `~/.pi/agent/models.json` (empty if none). */
export function configuredPiProviders(): Set<string> {
  try {
    const p = path.join(os.homedir(), ".pi", "agent", "models.json");
    const json = JSON.parse(fs.readFileSync(p, "utf-8")) as { providers?: Record<string, unknown> };
    if (json?.providers && typeof json.providers === "object") {
      return new Set(Object.keys(json.providers));
    }
  } catch {
    /* no / unreadable models.json → user has no custom providers */
  }
  return new Set();
}

/**
 * Parse the columnar output of `pi --list-models`:
 *   provider  model  context  max-out  thinking(yes/no)  images(yes/no)
 * No field contains internal whitespace, so a plain whitespace split is robust.
 * Only rows whose provider is in `providers` are returned; ids are namespaced
 * `provider/model` to round-trip through the engine.
 */
export function parsePiModels(output: string, providers: Set<string>): ModelInfo[] {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").trim();
    if (!line) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 6) continue;
    const provider = fields[0];
    const modelId = fields[1];
    const thinking = fields[4];
    const images = fields[5];
    // Skip the header and any non-data line: the capability columns must be yes/no.
    if (thinking !== "yes" && thinking !== "no") continue;
    if (images !== "yes" && images !== "no") continue;
    if (!providers.has(provider)) continue;

    const id = `${provider}/${modelId}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const supportsEffort = thinking === "yes";
    const ctx = parseTokens(fields[2]);
    models.push({
      id,
      label: modelId,
      supportsEffort,
      effortLevels: supportsEffort ? [...PI_EFFORT_LEVELS] : [],
      ...(ctx ? { contextWindow: ctx } : {}),
    });
  }
  return models;
}

/** Run `pi --list-models` and return the user's configured local/custom models. */
export async function discoverPiModels(bin: string): Promise<ModelInfo[]> {
  const providers = configuredPiProviders();
  if (providers.size === 0) {
    logger.info("Pi discovery: no custom providers in ~/.pi/agent/models.json — no local models surfaced");
    return [];
  }

  const output = await new Promise<string>((resolve) => {
    let out = "";
    let done = false;
    const finish = (s: string) => {
      if (done) return;
      done = true;
      resolve(s);
    };
    try {
      const proc = spawn(bin, ["--list-models"], { stdio: ["ignore", "pipe", "pipe"] });
      // Pi prints the model table to stderr; capture both streams to be safe.
      proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
      proc.stderr.on("data", (d: Buffer) => (out += d.toString()));
      // Graceful timeout: SIGTERM first so pi can exit cleanly, SIGKILL ~1s later
      // if it's still alive. finish() is idempotent, so resolving at SIGTERM time
      // is safe even though 'close' fires again after the kill.
      let killTimer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        killTimer = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, 1000);
        finish(out);
      }, 14000);
      proc.on("close", () => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        finish(out);
      });
      proc.on("error", (e) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        logger.warn(`pi --list-models failed: ${e.message}`);
        finish("");
      });
    } catch (e) {
      logger.warn(`pi --list-models spawn failed: ${e instanceof Error ? e.message : e}`);
      finish("");
    }
  });

  return parsePiModels(output, providers);
}
