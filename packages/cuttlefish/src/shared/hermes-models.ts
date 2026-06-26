import { spawn } from "node:child_process";
import type { ModelInfo } from "./types.js";
import { logger } from "./logger.js";

export const HERMES_EFFORT_LEVELS: string[] = [];

export interface HermesModelDiscovery {
  defaultModel?: string;
  models: ModelInfo[];
}

function hermesModelInfo(id: string, label?: string): ModelInfo {
  return { id, label: label || id, supportsEffort: false, effortLevels: [] };
}

/** Parse a `session/new` result payload into a model discovery. */
export function parseHermesModels(result: Record<string, unknown>): HermesModelDiscovery {
  const block = result?.models as Record<string, unknown> | undefined;
  const available = Array.isArray(block?.availableModels) ? (block!.availableModels as Array<Record<string, unknown>>) : [];
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const m of available) {
    const id = String(m.modelId ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push(hermesModelInfo(id, String(m.name ?? id)));
  }
  const defaultModel = block?.currentModelId ? String(block.currentModelId) : models[0]?.id;
  return { defaultModel, models };
}

/** Static last-resort catalog (only used when live discovery yields nothing). */
export function knownHermesModels(pinned?: string): HermesModelDiscovery {
  const ids = ["openai-codex:gpt-5.5", "openai-codex:gpt-5.4"];
  if (pinned && !ids.includes(pinned)) ids.unshift(pinned);
  return { defaultModel: pinned || ids[0], models: ids.map((id) => hermesModelInfo(id, id.includes(":") ? id.split(":")[1] : id)) };
}

/** Live discovery: spawn `hermes acp`, do a no-cost initialize+session/new handshake, read models, kill. */
export async function discoverHermesModels(bin: string): Promise<HermesModelDiscovery> {
  return new Promise<HermesModelDiscovery>((resolve) => {
    let done = false;
    const finish = (d: HermesModelDiscovery) => { if (!done) { done = true; try { proc.kill("SIGTERM"); } catch {} resolve(d); } };
    let buf = "";
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(bin, ["acp"], {
        stdio: ["pipe", "pipe", "ignore"],
        env: { ...process.env, HERMES_YOLO_MODE: "1", HERMES_ACCEPT_HOOKS: "1" },
      });
    } catch (e) {
      logger.warn(`hermes acp discovery spawn failed: ${e instanceof Error ? e.message : e}`);
      return resolve({ models: [] });
    }
    const timer = setTimeout(() => finish({ models: [] }), 20000);
    proc.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && msg.result) {
          proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } }) + "\n");
        } else if (msg.id === 2 && msg.result) {
          clearTimeout(timer);
          finish(parseHermesModels(msg.result as Record<string, unknown>));
        }
      }
    });
    proc.on("error", () => { clearTimeout(timer); finish({ models: [] }); });
    proc.on("close", () => { clearTimeout(timer); finish({ models: [] }); });
    proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } }) + "\n");
  });
}
