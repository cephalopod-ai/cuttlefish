import os from "node:os";
import { MuseHost, museCount, museRecord } from "../engines/muse-host.js";
import type { ModelInfo } from "./types.js";

export const MUSE_DEFAULT_MODEL = "muse-spark-1.3";
export const MUSE_EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];
/** MSP ReasoningEffort is a closed vocabulary; discovery keeps every tier the host advertises. */
const MUSE_PROTOCOL_EFFORT_LEVELS = ["none", ...MUSE_EFFORT_LEVELS, "ultra"];

function model(id: string, label: string): ModelInfo {
  return { id, label, supportsEffort: true, effortLevels: [...MUSE_EFFORT_LEVELS] };
}

export function knownMuseModels(): ModelInfo[] {
  return [
    model(MUSE_DEFAULT_MODEL, "Muse Spark 1.3 (fallback)"),
    model("muse-wonder-1.0", "Muse Wonder 1.0 (fallback)"),
    model("muse-spark-1.2", "Muse Spark 1.2 (fallback)"),
  ];
}

export async function discoverMuseModels(bin?: string): Promise<{ defaultModel?: string; models: ModelInfo[] }> {
  const host = new MuseHost(os.tmpdir(), bin);
  try {
    await host.initialize();
    const catalog = await host.request("model/list", {});
    const models: ModelInfo[] = [];
    let defaultModel: string | undefined;
    const rows = catalog.providerId === "meta" && catalog.source === "providerCatalog" && Array.isArray(catalog.models)
      ? catalog.models : [];
    for (const raw of rows) {
      const row = museRecord(raw);
      if (row.providerId !== "meta" || typeof row.modelId !== "string" || row.modelId.endsWith("-contributor")) continue;
      const efforts = Array.isArray(row.variants)
        ? row.variants.filter((level): level is string => typeof level === "string" && MUSE_PROTOCOL_EFFORT_LEVELS.includes(level))
        : [];
      const option = typeof row.displayLabel === "string" ? row.displayLabel : row.modelId;
      models.push({
        id: row.modelId,
        label: option,
        supportsEffort: efforts.length > 0,
        effortLevels: efforts,
        contextWindow: museCount(row.contextLimit),
      });
      if (row.isDefault === true) defaultModel = row.modelId;
    }
    if (!models.length) {
      const fallback = new Map(knownMuseModels().map((entry) => [entry.id, entry.label.replace(" (fallback)", "")]));
      for (const id of await host.modelIds()) models.push(model(id, fallback.get(id) ?? id));
    }
    return { defaultModel, models };
  } finally {
    await host.close(host.alive);
  }
}
