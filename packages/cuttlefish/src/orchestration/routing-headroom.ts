import { normalizeBoardWorkerConfig } from "../shared/config.js";
import { engineAvailable, isKnownEngine, type EngineName } from "../shared/models.js";
import type { CuttlefishConfig } from "../shared/types.js";
import { getEngineUsageStatus, type UsageStatus } from "../shared/usage-status.js";
import type { Worker } from "./types.js";

export interface EngineHeadroomResult {
  ok: boolean;
  provider: string;
  reason: string;
  status?: UsageStatus;
  minRemainingPercent?: number;
}

export interface EngineHeadroomOptions {
  now?: number;
  minRemainingPercent?: number;
  isEngineAvailable?: (config: CuttlefishConfig, engine: EngineName) => boolean;
  getUsageStatus?: (engine: EngineName, config: CuttlefishConfig, opts: { now?: number }) => Promise<UsageStatus>;
}

export interface HeadroomFilterResult {
  allowed: Worker[];
  rejected: Array<{ worker: Worker; headroom: EngineHeadroomResult }>;
}

export async function engineHasHeadroom(
  worker: Worker,
  config: CuttlefishConfig,
  opts: EngineHeadroomOptions = {},
): Promise<EngineHeadroomResult> {
  if (!isKnownEngine(worker.provider)) {
    return { ok: true, provider: worker.provider, reason: "non_live_provider" };
  }

  const isAvailable = opts.isEngineAvailable ?? engineAvailable;
  if (!isAvailable(config, worker.provider)) {
    return { ok: false, provider: worker.provider, reason: "engine_unavailable" };
  }

  const minRemainingPercent = opts.minRemainingPercent ?? normalizeBoardWorkerConfig(config.boardWorker).usage.minRemainingPercent;
  const getStatus = opts.getUsageStatus ?? getEngineUsageStatus;
  const status = await getStatus(worker.provider, config, { now: opts.now });
  if (status.state === "exhausted") {
    return { ok: false, provider: worker.provider, reason: "usage_exhausted", status, minRemainingPercent };
  }
  if (typeof status.remainingPercent === "number" && status.remainingPercent < minRemainingPercent) {
    return { ok: false, provider: worker.provider, reason: "usage_below_min_remaining", status, minRemainingPercent };
  }
  return { ok: true, provider: worker.provider, reason: `usage_${status.state}`, status, minRemainingPercent };
}

export async function filterWorkersWithHeadroom(
  workers: Worker[],
  config: CuttlefishConfig,
  opts: EngineHeadroomOptions = {},
): Promise<HeadroomFilterResult> {
  const allowed: Worker[] = [];
  const rejected: HeadroomFilterResult["rejected"] = [];
  for (const worker of workers) {
    const headroom = await engineHasHeadroom(worker, config, opts);
    if (headroom.ok) allowed.push(worker);
    else rejected.push({ worker, headroom });
  }
  return { allowed, rejected };
}
