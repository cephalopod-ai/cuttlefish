import { logger } from "./logger.js";
import type { ModelInfo } from "./types.js";
import { killChildTree, spawnCompat } from "./windows-exec.js";

export const ANTIGRAVITY_DEFAULT_MODEL = "gemini-3.8-flash-medium";

const ANTIGRAVITY_MODEL_LABELS: Record<string, string> = {
  "gemini-3.8-flash-high": "Gemini 3.8 Flash (High)",
  "gemini-3.8-flash-medium": "Gemini 3.8 Flash (Medium)",
  "gemini-3.8-flash-low": "Gemini 3.8 Flash (Low)",
  "gemini-3.7-flash-high": "Gemini 3.7 Flash (High)",
  "gemini-3.7-flash-medium": "Gemini 3.7 Flash (Medium)",
  "gemini-3.7-flash-low": "Gemini 3.7 Flash (Low)",
  "gemini-3.6-flash-high": "Gemini 3.6 Flash (High)",
  "gemini-3.6-flash-medium": "Gemini 3.6 Flash (Medium)",
  "gemini-3.6-flash-low": "Gemini 3.6 Flash (Low)",
  "gemini-3.1-pro-high": "Gemini 3.1 Pro (High)",
  "gemini-3.1-pro-low": "Gemini 3.1 Pro (Low)",
  "claude-sonnet-4-6": "Claude Sonnet 4.6 (Thinking)",
  "claude-opus-4-6-thinking": "Claude Opus 4.6 (Thinking)",
  "gpt-oss-120b-medium": "GPT-OSS 120B (Medium)",
};

const ANTIGRAVITY_MODEL_IDS = Object.keys(ANTIGRAVITY_MODEL_LABELS);

export interface AntigravityModelDiscovery {
  models: ModelInfo[];
}

function antigravityModelInfo(id: string, label = ANTIGRAVITY_MODEL_LABELS[id] ?? id): ModelInfo {
  return { id, label, supportsEffort: false, effortLevels: [] };
}

/** Known catalog used only until the installed CLI can answer `agy models`. */
export function knownAntigravityModels(pinned?: string): AntigravityModelDiscovery {
  const ids = [...ANTIGRAVITY_MODEL_IDS];
  if (pinned && !ids.includes(pinned)) ids.unshift(pinned);
  return { models: ids.map((id) => antigravityModelInfo(id)) };
}

/** Parse Antigravity's tab-separated `agy models` output. */
export function parseAntigravityModels(output: string): AntigravityModelDiscovery {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();

  for (const raw of output.split("\n")) {
    const line = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").trim();
    if (!line || /^Fetching available models/i.test(line)) continue;
    const columns = line.split(/\t+/);
    if (columns.length < 2) continue;
    const id = columns[0].trim();
    const label = columns.slice(1).join(" ").trim();
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    models.push(antigravityModelInfo(id, label));
  }

  return { models };
}

/** Run `agy models` and return exactly the models exposed by the installed CLI. */
export async function discoverAntigravityModels(bin: string): Promise<AntigravityModelDiscovery> {
  const output = await new Promise<string>((resolve) => {
    let out = "";
    let done = false;
    const finish = (value: string) => {
      if (done) return;
      done = true;
      resolve(value);
    };

    try {
      const proc = spawnCompat(bin, ["models"], { stdio: ["ignore", "pipe", "pipe"] });
      proc.stdout.on("data", (data: Buffer) => (out += data.toString()));
      proc.stderr.on("data", (data: Buffer) => (out += data.toString()));

      let killTimer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        try {
          killChildTree(proc, "SIGTERM");
        } catch {
          /* ignore */
        }
        killTimer = setTimeout(() => {
          try {
            killChildTree(proc, "SIGKILL");
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
      proc.on("error", (error) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        logger.warn(`agy models failed: ${error.message}`);
        finish("");
      });
    } catch (error) {
      logger.warn(`agy models spawn failed: ${error instanceof Error ? error.message : error}`);
      finish("");
    }
  });

  return parseAntigravityModels(output);
}
