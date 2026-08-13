import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { getSession } from "../../../sessions/registry.js";
import { createPtyAccessToken } from "../../auth.js";
import { handleSessionAttachment } from "../../files.js";
import { readJsonObjectBody } from "../../http-helpers.js";
import { exportRunBundle } from "../../run-bundles.js";
import { resolveUserHeader } from "../../connector-reply.js";
import type { ApiContext } from "../context.js";
import { matchRoute } from "../match-route.js";
import { json, notFound } from "../responses.js";
import { serializeSession } from "../serialize-session.js";
import type { GatewayPrincipal } from "../../auth.js";
import { continueSession } from "../../continue-session.js";
import { createSessionFromRequest } from "../../create-session.js";
import {
  attachSessionResources,
  bulkDeleteSessions,
  cancelSessionQueueItem,
  clearSessionQueue,
  deleteSessionAndCleanup,
  duplicateEngineSession,
  pauseSessionQueue,
  patchSession,
  resetSession,
  resumeSessionQueue,
  stopSession,
} from "../../session-lifecycle-service.js";

export async function handleSessionWriteRoutes(
  method: string,
  pathname: string,
  req: HttpRequest,
  res: ServerResponse,
  context: ApiContext,
): Promise<boolean> {
  let params = matchRoute("/api/sessions/:id", pathname);
  if ((method === "PUT" || method === "PATCH") && params) {
    if (!getSession(params.id)) {
      notFound(res);
      return true;
    }
    const parsed = await readJsonObjectBody(req, res);
    if (!parsed.ok) return true;
    const result = patchSession(params.id, parsed.body, context);
    json(res, result.body, result.statusCode);
    return true;
  }

  params = matchRoute("/api/sessions/:id/pty-token", pathname);
  if (method === "POST" && params) {
    const session = getSession(params.id);
    if (!session) {
      notFound(res);
      return true;
    }
    if (!context.apiToken) {
      json(res, { error: "PTY auth unavailable" }, 503);
      return true;
    }
    const ptyEngine = context.ptyViewEngines?.[session.engine];
    if (!ptyEngine) {
      json(res, { error: "Session engine has no PTY view" }, 409);
      return true;
    }
    json(res, { token: createPtyAccessToken(params.id, context.apiToken), expiresInMs: 60_000 });
    return true;
  }

  params = matchRoute("/api/sessions/:id", pathname);
  if (method === "DELETE" && params) {
    const result = deleteSessionAndCleanup(params.id, context);
    json(res, result.body, result.statusCode);
    return true;
  }

  params = matchRoute("/api/sessions/:id/stop", pathname);
  if (method === "POST" && params) {
    const result = stopSession(params.id, context);
    json(res, result.body, result.statusCode);
    return true;
  }

  params = matchRoute("/api/sessions/:id/reset", pathname);
  if (method === "POST" && params) {
    const result = resetSession(params.id, context);
    json(res, result.body, result.statusCode);
    return true;
  }

  params = matchRoute("/api/sessions/:id/duplicate", pathname);
  if (method === "POST" && params) {
    const result = await duplicateEngineSession(params.id, context);
    json(res, result.body, result.statusCode);
    return true;
  }

  const queueItemParams = matchRoute("/api/sessions/:id/queue/:itemId", pathname);
  if (method === "DELETE" && queueItemParams) {
    const result = cancelSessionQueueItem(queueItemParams.id, queueItemParams.itemId, context);
    json(res, result.body, result.statusCode);
    return true;
  }

  params = matchRoute("/api/sessions/:id/queue", pathname);
  if (method === "DELETE" && params) {
    const result = clearSessionQueue(params.id, context);
    json(res, result.body, result.statusCode);
    return true;
  }

  params = matchRoute("/api/sessions/:id/queue/pause", pathname);
  if (method === "POST" && params) {
    const result = pauseSessionQueue(params.id, context);
    json(res, result.body, result.statusCode);
    return true;
  }

  params = matchRoute("/api/sessions/:id/queue/resume", pathname);
  if (method === "POST" && params) {
    const result = await resumeSessionQueue(params.id, context);
    json(res, result.body, result.statusCode);
    return true;
  }

  if (method === "POST" && pathname === "/api/sessions/bulk-delete") {
    const parsed = await readJsonObjectBody(req, res);
    if (!parsed.ok) return true;
    const result = bulkDeleteSessions(parsed.body.ids, context);
    json(res, result.body, result.statusCode);
    return true;
  }

  if (method === "POST" && pathname === "/api/sessions") {
    const parsed = await readJsonObjectBody(req, res);
    if (!parsed.ok) return true;
    const principal = (req as HttpRequest & { cuttlefishPrincipal?: GatewayPrincipal }).cuttlefishPrincipal;
    const result = await createSessionFromRequest({
      body: parsed.body,
      context,
      principal,
      userId: resolveUserHeader(req.headers, context.getConfig().gateway.userHeader),
    });
    json(res, result.body, result.statusCode);
    return true;
  }

  params = matchRoute("/api/sessions/:id/message", pathname);
  if (method === "POST" && params) {
    const parsed = await readJsonObjectBody(req, res);
    if (!parsed.ok) return true;
    const principal = (req as HttpRequest & { cuttlefishPrincipal?: GatewayPrincipal }).cuttlefishPrincipal;
    const result = await continueSession({
      sessionId: params.id,
      body: parsed.body,
      context,
      principal,
      userId: resolveUserHeader(req.headers, context.getConfig().gateway.userHeader),
    });
    json(res, result.body, result.statusCode);
    return true;
  }

  params = matchRoute("/api/sessions/:id/attachments", pathname);
  if (method === "POST" && params) {
    const session = getSession(params.id);
    if (!session) {
      notFound(res);
      return true;
    }
    await handleSessionAttachment(req, res, params.id, context);
    return true;
  }

  params = matchRoute("/api/sessions/:id/resources", pathname);
  if (params) {
    const session = getSession(params.id);
    if (!session) {
      notFound(res);
      return true;
    }
    if (method === "GET") {
      json(res, { attachments: serializeSession(session, context).attachments ?? [] });
      return true;
    }
    if (method === "POST") {
      const parsed = await readJsonObjectBody(req, res);
      if (!parsed.ok) return true;
      const result = await attachSessionResources(params.id, parsed.body, context);
      json(res, result.body, result.statusCode);
      return true;
    }
  }

  params = matchRoute("/api/sessions/:id/bundle", pathname);
  if (method === "POST" && params) {
    const session = getSession(params.id);
    if (!session) {
      notFound(res);
      return true;
    }
    try {
      const bundle = exportRunBundle(session.id, context);
      context.emit("bundle:exported", { bundleId: bundle.id, sessionId: session.id, bundlePath: bundle.bundlePath });
      json(res, bundle, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : "bundle export failed";
      if (message.includes("not found")) {
        notFound(res);
        return true;
      }
      if (message.includes("not complete enough")) {
        json(res, { error: message }, 409);
        return true;
      }
      throw err;
    }
    return true;
  }

  return false;
}
