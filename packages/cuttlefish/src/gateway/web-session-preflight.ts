import type { CuttlefishConfig, Engine, Session } from "../shared/types.js";
import { beginSessionRun, getSession, insertMessage, updateSession } from "../sessions/registry.js";
import { logger } from "../shared/logger.js";
import { notifyParentSession } from "../sessions/callbacks.js";
import { maybeEmitTalkGraph } from "../talk/graph.js";
import { isExecutionDepthBlocked } from "./employee-execution.js";
import type { ApiContext } from "./api/context.js";

export interface PreparedWebSessionRun {
  currentSession: Session;
  config: CuttlefishConfig;
  engine: Engine;
  isRoleChildSession: boolean;
}

/**
 * Establish the durable run and resolve its executable engine before the turn
 * pipeline constructs prompts or opens streaming state. Keeping this lifecycle
 * boundary separate prevents the large web runner from owning both transport
 * recovery and execution orchestration.
 */
export function prepareWebSessionRun(input: {
  session: Session;
  prompt: string;
  engine: Engine;
  config: CuttlefishConfig;
  context: ApiContext;
}): PreparedWebSessionRun | undefined {
  let currentSession = getSession(input.session.id);
  if (!currentSession) {
    logger.info(`Skipping deleted web session ${input.session.id} before run start`);
    return undefined;
  }
  currentSession = beginSessionRun({
    sessionId: currentSession.id,
    prompt: input.prompt,
    transportMeta: currentSession.transportMeta,
  }) ?? currentSession;
  const config = input.context.getConfig();
  // Role sessions (mid_pair reviewer / revision-implementer, executionDepth ≥ 1)
  // are internal/silent — see the notifyParentSession suppression note below.
  // Compute this before engine resolution so it covers the early error path too.
  const isRoleChildSession = isExecutionDepthBlocked(currentSession.transportMeta as Record<string, unknown> | undefined);
  const preferredPtyView = input.context.ptyViewEngines?.[input.session.engine] === input.engine;
  const runtimeEngine =
    (preferredPtyView ? input.context.ptyViewEngines?.[currentSession.engine] : undefined)
    ?? input.context.sessionManager.getEngine(currentSession.engine);
  if (!runtimeEngine) {
    const errMsg = `Engine "${currentSession.engine}" not available`;
    logger.error(`Web session ${currentSession.id} blocked: ${errMsg}`);
    insertMessage(currentSession.id, "assistant", `⛔ ${errMsg}`);
    const erroredSession = updateSession(currentSession.id, {
      status: "error",
      lastActivity: new Date().toISOString(),
      lastError: errMsg,
    });
    input.context.emit("session:completed", { sessionId: currentSession.id, result: null, error: errMsg });
    maybeEmitTalkGraph(currentSession.id, "completed", { getSession, emit: input.context.emit });
    if (erroredSession) {
      notifyParentSession(erroredSession, {
        error: errMsg,
      }, {
        alwaysNotify: isRoleChildSession ? false : undefined,
        sink: input.context.notificationSink,
      });
    }
    return undefined;
  }
  logger.info(`Web session ${currentSession.id} running engine "${currentSession.engine}" (model: ${currentSession.model || "default"})`);

  const currentStatus = getSession(currentSession.id);
  if (currentStatus && currentStatus.status !== "running") {
    updateSession(currentSession.id, {
      status: "running",
      lastActivity: new Date().toISOString(),
    });
  }
  return { currentSession, config, engine: runtimeEngine, isRoleChildSession };
}
