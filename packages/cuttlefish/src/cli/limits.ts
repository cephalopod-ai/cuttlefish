import fs from "node:fs";
import { loadConfig } from "../shared/config.js";
import { CUTTLEFISH_HOME } from "../shared/paths.js";
import { collectEngineLimits } from "../shared/engine-limits.js";
import { refreshCodexModels, refreshGrokModels, refreshPiModels, refreshHermesModels } from "../shared/models.js";
import type { EngineLimitEngineSnapshot, EngineLimitWindow } from "../shared/types.js";

export interface LimitsOptions {
  json?: boolean;
  engine?: string;
}

function formatReset(window: EngineLimitWindow): string {
  if (!window.resetsAtIso) return "";
  return `, resets ${new Date(window.resetsAtIso).toLocaleString()}`;
}

function formatDuration(minutes?: number): string {
  if (!minutes) return "";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function formatWindow(window: EngineLimitWindow): string {
  const used = window.usedPercent === undefined ? "unknown" : `${window.usedPercent}%`;
  const duration = window.windowDurationMins ? `/${formatDuration(window.windowDurationMins)}` : "";
  return `${window.name}${duration}: ${used} used${formatReset(window)}`;
}

function printEngine(engine: EngineLimitEngineSnapshot): void {
  const badge = engine.available ? engine.status : "missing";
  console.log(`${engine.name} (${badge})`);
  console.log(`  Source: ${engine.source}`);
  if (engine.accountPlan) console.log(`  Plan: ${engine.accountPlan}`);
  if (engine.defaultModel) console.log(`  Default model: ${engine.defaultModel}`);

  if (engine.windows?.length) {
    console.log("  Limits:");
    for (const window of engine.windows) console.log(`    - ${formatWindow(window)}`);
  }

  if (engine.buckets && engine.buckets.length > 1) {
    console.log("  Buckets:");
    for (const bucket of engine.buckets) {
      const label = bucket.name ? `${bucket.id} (${bucket.name})` : bucket.id;
      const parts = [bucket.primary, bucket.secondary].filter(Boolean).map((w) => formatWindow(w!));
      console.log(`    - ${label}${bucket.planType ? `, plan ${bucket.planType}` : ""}`);
      for (const part of parts) console.log(`      ${part}`);
    }
  }

  if (engine.credits) {
    const creditBits = [
      engine.credits.unlimited === true ? "unlimited" : undefined,
      engine.credits.hasCredits === false ? "no credits" : undefined,
      engine.credits.balance ? `balance ${engine.credits.balance}` : undefined,
      engine.credits.remainingPercent !== undefined ? `${engine.credits.remainingPercent}% remaining` : undefined,
    ].filter(Boolean);
    if (creditBits.length) console.log(`  Credits: ${creditBits.join(", ")}`);
  }

  if (engine.context) {
    const size = engine.context.contextWindowSize ? ` of ${engine.context.contextWindowSize.toLocaleString()} tokens` : "";
    const used = engine.context.usedPercent === undefined ? "unknown" : `${engine.context.usedPercent}%`;
    console.log(`  Context: ${used}${size}`);
  }

  if (engine.models.length) {
    console.log(`  Models: ${engine.models.map((m) => m.label || m.id).join(", ")}`);
  }

  if (engine.unsupportedReason) console.log(`  Note: ${engine.unsupportedReason}`);
  if (engine.error) console.log(`  Error: ${engine.error}`);
  if (engine.stale) console.log("  Note: latest snapshot is older than 30 minutes.");
}

export async function runLimits(opts: LimitsOptions = {}): Promise<void> {
  if (!fs.existsSync(CUTTLEFISH_HOME)) {
    console.log("Gateway is not set up. Run \"cuttlefish setup\" first.");
    return;
  }

  const config = loadConfig();
  const refreshOptions = opts.json ? { quiet: true } : undefined;
  await refreshCodexModels(config, refreshOptions);
  await refreshPiModels(config, refreshOptions);
  await refreshGrokModels(config, refreshOptions);
  await refreshHermesModels(config, refreshOptions);
  const snapshot = await collectEngineLimits(config, { engine: opts.engine });

  if (opts.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  console.log(`Engine limits (${new Date(snapshot.generatedAt).toLocaleString()})`);
  for (const engine of Object.values(snapshot.engines)) {
    console.log("");
    printEngine(engine);
  }
}
