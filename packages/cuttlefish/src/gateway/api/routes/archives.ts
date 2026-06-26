import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import type { ArchiveKind, Session } from "../../../shared/types.js";
import { createArchiveAndDeleteSessions, deleteArchive, getArchive, getSession, listArchives } from "../../../sessions/registry.js";
import type { ApiContext } from "../context.js";
import { matchRoute } from "../match-route.js";
import { badRequest, json, notFound } from "../responses.js";
import { killSessionEngines } from "../session-dispatch.js";
import { readJsonBody } from "../../http-helpers.js";
import { logger } from "../../../shared/logger.js";
import { maybeEmitTalkGraph } from "../../../talk/graph.js";

export async function handleArchiveRoutes(
  method: string,
  pathname: string,
  req: HttpRequest,
  res: ServerResponse,
  context: ApiContext,
): Promise<boolean> {
  if (method === "GET" && pathname === "/api/archives") {
    json(res, listArchives());
    return true;
  }

  if (method === "POST" && pathname === "/api/archives") {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as Record<string, unknown>;
    const sessionIds: string[] = Array.isArray(body.sessionIds) ? (body.sessionIds as string[]) : [];
    if (sessionIds.length === 0) {
      badRequest(res, "sessionIds array is required");
      return true;
    }
    const liveSessions = sessionIds.map((id) => getSession(id)).filter((session): session is Session => Boolean(session));
    const archive = createArchiveAndDeleteSessions({
      label: typeof body.label === "string" ? body.label : null,
      note: typeof body.note === "string" ? body.note : null,
      kind: (typeof body.kind === "string" ? body.kind : "chat") as ArchiveKind,
      sourceRef: typeof body.sourceRef === "string" ? body.sourceRef : null,
      sessionIds,
    });
    if (!archive) {
      badRequest(res, "no matching sessions to archive");
      return true;
    }

    const archivedSessions = new Map(liveSessions.map((session) => [session.id, session]));
    for (const session of liveSessions) {
      try {
        killSessionEngines(context, session, "Interrupted: session archived");
      } catch (err) {
        logger.warn(`Failed to interrupt archived session ${session.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);
      } catch (err) {
        logger.warn(`Failed to clear queue for archived session ${session.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
      maybeEmitTalkGraph(session.id, "removed", {
        getSession: (id) => archivedSessions.get(id) ?? getSession(id),
        emit: context.emit,
      });
      context.emit("session:deleted", { sessionId: session.id });
      logger.info(`Archived and deleted session ${session.id} into archive ${archive.id}`);
    }
    context.emit("archive:created", { archive });
    json(res, archive);
    return true;
  }

  const archiveParams = matchRoute("/api/archives/:id", pathname);
  if (method === "GET" && archiveParams) {
    const archive = getArchive(archiveParams.id);
    if (!archive) {
      notFound(res);
      return true;
    }
    json(res, archive);
    return true;
  }

  if (method === "DELETE" && archiveParams) {
    if (!deleteArchive(archiveParams.id)) {
      notFound(res);
      return true;
    }
    context.emit("archive:deleted", { archiveId: archiveParams.id });
    json(res, { status: "deleted" });
    return true;
  }

  return false;
}
