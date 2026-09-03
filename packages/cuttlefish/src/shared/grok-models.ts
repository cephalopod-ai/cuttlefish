import { killChildTree, spawnCompat } from "./windows-exec.js";
import type { ModelInfo } from "./types.js";
import { logger } from "./logger.js";

export const GROK_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
export const GROK_DEFAULT_MODEL = "grok-4.6";

const GROK_MODEL_LABELS: Record<string, string> = {
  "grok-4.6": "Grok 4.6",
  "grok-4.5": "Grok 4.5",
};

export interface GrokModelDiscovery {
  defaultModel?: string;
  models: ModelInfo[];
}

export function labelGrokModel(id: string): string {
  return GROK_MODEL_LABELS[id] ?? id;
}

/**
 * `grok-build` is retained only as a compatibility sentinel. Operator-facing
 * status must describe the current CLI behavior instead of presenting that
 * retired id as though it were the model that will run.
 */
export function describeGrokModelForOperator(model?: string): string {
  if (model === "grok-build") return `${GROK_DEFAULT_MODEL} (CLI default via legacy grok-build compatibility)`;
  return model?.trim() || GROK_DEFAULT_MODEL;
}

function grokModelInfo(id: string): ModelInfo {
  return {
    id,
    label: labelGrokModel(id),
    supportsEffort: true,
    effortLevels: [...GROK_EFFORT_LEVELS],
  };
}

export function knownGrokModels(pinned?: string): GrokModelDiscovery {
  const ids = ["grok-4.6", "grok-4.5"];
  if (pinned && !ids.includes(pinned)) ids.unshift(pinned);
  return {
    defaultModel: pinned || GROK_DEFAULT_MODEL,
    models: ids.map(grokModelInfo),
  };
}

/** Parse `grok models` output:
 *
 *   Default model: grok-4.6
 *   Available models:
 *     * grok-4.6 (default)
 *     - grok-4.5
 */
export function parseGrokModels(output: string): GrokModelDiscovery {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  let defaultModel: string | undefined;

  for (const raw of output.split("\n")) {
    const line = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").trim();
    if (!line) continue;

    const defaultMatch = /^Default model:\s+(\S+)/i.exec(line);
    if (defaultMatch) {
      defaultModel = defaultMatch[1];
      continue;
    }

    const modelMatch = /^[*-]\s+(\S+)(?:\s+\(default\))?$/i.exec(line);
    if (!modelMatch) continue;

    const id = modelMatch[1];
    if (seen.has(id)) continue;
    seen.add(id);
    if (/\(default\)/i.test(line)) defaultModel = id;
    models.push(grokModelInfo(id));
  }

  return { defaultModel, models };
}

/** Run `grok models` and return the models the installed/authenticated CLI exposes. */
export async function discoverGrokModels(bin: string): Promise<GrokModelDiscovery> {
  const output = await new Promise<string>((resolve) => {
    let out = "";
    let done = false;
    const finish = (s: string) => {
      if (done) return;
      done = true;
      resolve(s);
    };

    try {
      const proc = spawnCompat(bin, ["models"], { stdio: ["ignore", "pipe", "pipe"] });
      proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
      proc.stderr.on("data", (d: Buffer) => (out += d.toString()));

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
      proc.on("error", (e) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        logger.warn(`grok models failed: ${e.message}`);
        finish("");
      });
    } catch (e) {
      logger.warn(`grok models spawn failed: ${e instanceof Error ? e.message : e}`);
      finish("");
    }
  });

  return parseGrokModels(output);
}
