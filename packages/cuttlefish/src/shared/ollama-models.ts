import { logger } from "./logger.js";
import type { ModelInfo } from "./types.js";
import { killChildTree, spawnCompat } from "./windows-exec.js";

export interface OllamaModelDiscovery {
  models: ModelInfo[];
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

/** Parse the first (NAME) column from `ollama list`. */
export function parseOllamaList(output: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of stripAnsi(output).split("\n")) {
    const line = raw.trim();
    if (!line || /^NAME\s+ID\s+/i.test(line)) continue;
    const id = line.split(/\s+/)[0];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** Keep generation-capable models and carry their reported context length. */
export function modelInfoFromOllamaShow(id: string, output: string): ModelInfo | null {
  const clean = stripAnsi(output);
  const capabilities: string[] = [];
  let readingCapabilities = false;
  for (const raw of clean.split("\n")) {
    const line = raw.trim();
    if (!readingCapabilities && line === "Capabilities") {
      readingCapabilities = true;
      continue;
    }
    if (!readingCapabilities) continue;
    if (!line) {
      if (capabilities.length > 0) break;
      continue;
    }
    capabilities.push(line);
  }
  if (!capabilities.includes("completion")) return null;
  const contextMatch = /^\s*context length\s+(\d+)\s*$/im.exec(clean);
  return {
    id,
    label: id,
    supportsEffort: false,
    effortLevels: [],
    ...(contextMatch ? { contextWindow: Number(contextMatch[1]) } : {}),
  };
}

async function runOllama(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve) => {
    let out = "";
    let done = false;
    const finish = (value: string) => {
      if (done) return;
      done = true;
      resolve(value);
    };

    try {
      const proc = spawnCompat(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
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
      }, timeoutMs);
      proc.on("close", () => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        finish(out);
      });
      proc.on("error", (error) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        logger.warn(`ollama ${args[0]} failed: ${error.message}`);
        finish("");
      });
    } catch (error) {
      logger.warn(`ollama ${args[0]} spawn failed: ${error instanceof Error ? error.message : error}`);
      finish("");
    }
  });
}

/** Discover locally installed, completion-capable Ollama models. */
export async function discoverOllamaModels(bin: string): Promise<OllamaModelDiscovery> {
  const ids = parseOllamaList(await runOllama(bin, ["list"], 5000)).slice(0, 100);
  const inspected = await Promise.all(ids.map(async (id) => modelInfoFromOllamaShow(id, await runOllama(bin, ["show", id], 5000))));
  return { models: inspected.filter((model): model is ModelInfo => model !== null) };
}
