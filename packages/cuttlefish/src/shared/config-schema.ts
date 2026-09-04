/**
 * Compatibility facade for Cuttlefish config-shape validation.
 *
 * `validateConfigShape` is the single public entry point and the only name this
 * module has ever exported; `shared/config.ts` imports and re-exports it, and
 * every config-load path in the daemon and CLI reaches it from there. Keep that
 * export and this path (`./config-schema.js`) stable — DEC-20260625-002 requires
 * public import paths to survive modularization.
 *
 * The per-section validators live in sibling modules and are imported here, not
 * re-exported: they were module-private before the split and stay private.
 * Where each responsibility now lives:
 *
 * - `config-schema-primitives.ts` — value-shape helpers shared by every section
 * - `config-schema-workspaces.ts` — workspaces, profiles, autonomous-mode singleton
 * - `config-schema-engines.ts` — engines and the per-engine model registry
 * - `config-schema-connectors.ts` — connectors, notifications, connector cross-check
 * - `config-schema-email.ts` — email polling and IMAP inboxes
 * - `config-schema-mcp.ts` — built-in and custom MCP servers
 * - `config-schema-model-fallback.ts` — fallback chain, triggers, handoff, return policy
 * - `config-schema-runtime.ts` — gateway, logging, sessions, features, policy, remotes
 * - `config-schema-scheduling.ts` — board worker, orchestration, cron
 * - `config-schema-interaction.ts` — portal, context, stt, talk
 * - `config-schema-knowledge.ts` — knowledge sink and read provider (pre-existing;
 *   it takes its primitives as an injected helper bag, so this file passes them in)
 *
 * The order of the checks below is load-bearing: it fixes the order problems are
 * reported to the operator. Adding a section means adding a key to the allow-list
 * and a call in the same relative position, not reordering the existing calls.
 */
import { validateKnowledge } from "./config-schema-knowledge.js";
import { validateA2A } from "./config-schema-a2a.js";
import {
  isPlainObject,
  pushUnknownKeys,
  validateNumber,
  validateString,
} from "./config-schema-primitives.js";
import { validateAutonomousModeSingleton, validateWorkspaces } from "./config-schema-workspaces.js";
import { validateEngines, validateModels } from "./config-schema-engines.js";
import {
  validateConnectors,
  validateNotificationConnectorReference,
  validateNotifications,
} from "./config-schema-connectors.js";
import { validateEmail } from "./config-schema-email.js";
import { validateMcp } from "./config-schema-mcp.js";
import { validateModelFallback } from "./config-schema-model-fallback.js";
import {
  validateFeatures,
  validateGateway,
  validateLogging,
  validatePolicy,
  validateRemotes,
  validateSessions,
} from "./config-schema-runtime.js";
import {
  validateBoardWorker,
  validateCron,
  validateOrchestration,
} from "./config-schema-scheduling.js";
import {
  validateContext,
  validatePortal,
  validateStt,
  validateTalk,
} from "./config-schema-interaction.js";

export function validateConfigShape(config: unknown): string[] {
  if (config === null || config === undefined) {
    return ["file is empty or parsed to null — expected a YAML mapping"];
  }
  if (typeof config !== "object" || Array.isArray(config)) {
    return [`expected a YAML mapping, got ${Array.isArray(config) ? "an array" : typeof config}`];
  }

  const problems: string[] = [];
  const c = config as Record<string, unknown>;

  pushUnknownKeys(problems, c, [
    "cuttlefish",
    "workspaces",
    "gateway",
    "engines",
    "models",
    "connectors",
    "email",
    "logging",
    "mcp",
    "modelFallback",
    "orchestration",
    "sessions",
    "features",
    "boardWorker",
    "cron",
    "notifications",
    "portal",
    "context",
    "stt",
    "talk",
    "a2a",
    "knowledge",
    "remotes",
    "policy",
  ], "config");

  if (c.cuttlefish !== undefined) {
    if (!isPlainObject(c.cuttlefish)) {
      problems.push("cuttlefish must be a mapping");
    } else {
      pushUnknownKeys(problems, c.cuttlefish, ["version"], "cuttlefish");
      if (c.cuttlefish.version !== undefined) validateString(problems, "cuttlefish.version", c.cuttlefish.version);
    }
  }
  if (c.workspaces !== undefined) {
    validateWorkspaces(problems, c.workspaces);
    validateAutonomousModeSingleton(problems, c.workspaces);
  }
  if (c.gateway !== undefined) validateGateway(problems, c.gateway);
  validateEngines(problems, c.engines);
  if (c.models !== undefined) validateModels(problems, c.models);
  if (c.connectors !== undefined) validateConnectors(problems, c.connectors);
  if (c.email !== undefined) validateEmail(problems, c.email);
  if (c.logging !== undefined) validateLogging(problems, c.logging);
  if (c.mcp !== undefined) validateMcp(problems, c.mcp);
  if (c.modelFallback !== undefined) validateModelFallback(problems, c.modelFallback);
  if (c.orchestration !== undefined) validateOrchestration(problems, c.orchestration);
  if (c.sessions !== undefined) validateSessions(problems, c.sessions);
  if (c.features !== undefined) validateFeatures(problems, c.features);
  if (c.boardWorker !== undefined) validateBoardWorker(problems, c.boardWorker);
  if (c.cron !== undefined) validateCron(problems, c.cron);
  if (c.notifications !== undefined) validateNotifications(problems, c.notifications);
  if (c.portal !== undefined) validatePortal(problems, c.portal);
  if (c.context !== undefined) validateContext(problems, c.context);
  if (c.stt !== undefined) validateStt(problems, c.stt);
  if (c.talk !== undefined) validateTalk(problems, c.talk);
  if (c.a2a !== undefined) validateA2A(problems, c.a2a);
  if (c.knowledge !== undefined) validateKnowledge(problems, c.knowledge, { pushUnknownKeys, validateString, validateNumber });
  if (c.remotes !== undefined) validateRemotes(problems, c.remotes);
  if (c.policy !== undefined) validatePolicy(problems, c.policy);
  validateNotificationConnectorReference(problems, c);

  return problems;
}
