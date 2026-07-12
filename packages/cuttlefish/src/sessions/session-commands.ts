/**
 * Slash-command handling for SessionManager (ARC-CF-001).
 *
 * The operator/agent slash commands (`/new`, `/status`, `/model`, `/doctor`,
 * `/cron ...`) are a self-contained policy family with narrow dependencies. They
 * are extracted here so `SessionManager` keeps shrinking toward an orchestration
 * shell, and so the command surface can be tested and evolved without dragging
 * in the full turn-execution path. `SessionManager.handleCommand` /
 * `resetSession` delegate to these functions, preserving their public contracts.
 */
import type {
  Connector,
  Engine,
  IncomingMessage,
  CuttlefishConfig,
  Target,
} from "../shared/types.js";
import {
  isInterruptibleEngine,
} from "../shared/types.js";
import {
  deleteSession,
  getSessionBySessionKey,
  updateSession,
} from "./registry.js";
import type { SessionQueue } from "./queue.js";
import { logger } from "../shared/logger.js";
import { loadJobs } from "../cron/jobs.js";
import { setCronJobEnabled, triggerCronJob } from "../cron/scheduler.js";

/** Everything the command handler needs from the owning SessionManager. */
export interface SessionCommandDeps {
  config: CuttlefishConfig;
  queue: SessionQueue;
  engines: Map<string, Engine>;
  connectorProvider: () => Map<string, Connector>;
}

/**
 * Reset (delete) the session for a conversation, tearing down any warm engine
 * process first. Behavior-preserving move of `SessionManager.resetSession`.
 */
export function resetSession(deps: Pick<SessionCommandDeps, "engines">, sessionKey: string): void {
  const session = getSessionBySessionKey(sessionKey);
  if (session) {
    const engine = deps.engines.get(session.engine);
    if (engine && isInterruptibleEngine(engine)) {
      engine.kill(session.id, "Interrupted: session reset");
    }
    deleteSession(session.id);
    logger.info(`Deleted session ${session.id}`);
  }
}

/**
 * Handle a slash command. Returns true if the text was a recognized command
 * (and a reply was sent), false otherwise so the caller routes it as a normal
 * turn. Behavior-preserving move of `SessionManager.handleCommand`.
 */
export async function handleSessionCommand(
  deps: SessionCommandDeps,
  msg: IncomingMessage,
  connector: Connector,
): Promise<boolean> {
  const text = msg.text.trim();
  const target = connector.reconstructTarget(msg.replyContext);
  target.messageTs ??= msg.messageId;

  if (text === "/new" || text.startsWith("/new ")) {
    resetSession(deps, msg.sessionKey);
    await connector.replyMessage(target, "Session reset. Starting fresh.");
    logger.info(`Session reset for ${msg.sessionKey}`);
    return true;
  }

  if (text === "/status" || text.startsWith("/status ")) {
    const session = getSessionBySessionKey(msg.sessionKey);
    if (!session) {
      await connector.replyMessage(target, "No active session for this conversation.");
      return true;
    }
    const queueDepth = deps.queue.getPendingCount(session.sessionKey);
    const transportState = deps.queue.getTransportState(session.sessionKey, session.status);
    const info = [
      `Session: ${session.id}`,
      `Engine: ${session.engine}`,
      `Connector: ${session.connector || session.source}`,
      `Model: ${session.model || deps.config.engines[session.engine as "claude" | "codex" | "antigravity" | "grok" | "pi" | "kiro" | "hermes" | "ollama" | "kilo"]?.model || "default"}`,
      `State: ${transportState}`,
      `Queue depth: ${queueDepth}`,
      `Created: ${session.createdAt}`,
      `Last activity: ${session.lastActivity}`,
      session.lastError ? `Last error: ${session.lastError}` : null,
    ].filter(Boolean).join("\n");

    await connector.replyMessage(target, info);
    return true;
  }

  if (text.startsWith("/model")) {
    const nextModel = text.slice("/model".length).trim();
    if (!nextModel) {
      await connector.replyMessage(target, "Usage: /model <model-name>");
      return true;
    }

    const session = getSessionBySessionKey(msg.sessionKey);
    if (!session) {
      await connector.replyMessage(target, "No active session for this conversation.");
      return true;
    }

    updateSession(session.id, {
      model: nextModel,
      lastActivity: new Date().toISOString(),
    });
    await connector.replyMessage(target, `Model updated to \`${nextModel}\` for this session.`);
    return true;
  }

  if (text === "/doctor" || text.startsWith("/doctor ")) {
    const connectors = Array.from(deps.connectorProvider().values());
    const connectorLines = connectors.length > 0
      ? connectors.map((candidate) => {
          const health = candidate.getHealth();
          return `- ${candidate.name}: ${health.status}${health.detail ? ` (${health.detail})` : ""}`;
        })
      : ["- none"];
    const info = [
      `Default engine: ${deps.config.engines.default}`,
      `Claude: ${deps.config.engines.claude.model}`,
      `Codex: ${deps.config.engines.codex.model}`,
      ...(deps.config.engines.antigravity ? [`Antigravity: ${deps.config.engines.antigravity.model ?? "Gemini 3.5 Flash (Medium)"}`] : []),
      ...(deps.config.engines.grok ? [`Grok: ${deps.config.engines.grok.model ?? "grok-4.5"}`] : []),
      ...(deps.config.engines.ollama ? [`Ollama: ${deps.config.engines.ollama.model ?? "gemma4"}`] : []),
      ...(deps.config.engines.kilo ? [`Kilo: ${deps.config.engines.kilo.model ?? "default"}`] : []),
      "Connectors:",
      ...connectorLines,
    ].join("\n");
    await connector.replyMessage(target, info);
    return true;
  }

  if (text.startsWith("/cron")) {
    return handleCronCommand(text, connector, target);
  }

  return false;
}

async function handleCronCommand(text: string, connector: Connector, target: Target): Promise<boolean> {
  const [_, subcommand = "", ...rest] = text.split(/\s+/);
  const arg = rest.join(" ").trim();

  if (!subcommand || subcommand === "list") {
    const jobs = loadJobs();
    if (jobs.length === 0) {
      await connector.replyMessage(target, "No cron jobs configured.");
      return true;
    }

    const lines = jobs.map((job) =>
      `- ${job.name} (${job.id}) — ${job.enabled ? "enabled" : "disabled"} — ${job.schedule}`,
    );
    await connector.replyMessage(target, ["Cron jobs:", ...lines].join("\n"));
    return true;
  }

  if (subcommand === "run") {
    if (!arg) {
      await connector.replyMessage(target, "Usage: /cron run <job-id-or-name>");
      return true;
    }
    const result = await triggerCronJob(arg);
    await connector.replyMessage(
      target,
      !result.found
        ? `Cron job "${arg}" not found.`
        : !result.started
          ? `Cron job "${result.job.name}" already running; skipped overlap.`
          : `Triggered cron job "${result.job.name}".`,
    );
    return true;
  }

  if (subcommand === "enable" || subcommand === "disable") {
    if (!arg) {
      await connector.replyMessage(target, `Usage: /cron ${subcommand} <job-id-or-name>`);
      return true;
    }
    const job = setCronJobEnabled(arg, subcommand === "enable");
    await connector.replyMessage(
      target,
      job
        ? `Cron job "${job.name}" ${job.enabled ? "enabled" : "disabled"}.`
        : `Cron job "${arg}" not found.`,
    );
    return true;
  }

  await connector.replyMessage(target, "Usage: /cron [list|run|enable|disable] <job-id-or-name>");
  return true;
}
