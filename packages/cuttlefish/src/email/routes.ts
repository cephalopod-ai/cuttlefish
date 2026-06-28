import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { readJsonBody } from "../gateway/http-helpers.js";
import type { ApiContext } from "../gateway/api/context.js";
import { json, badRequest, notFound } from "../gateway/api/responses.js";

export async function handleEmailRoutes(
  method: string,
  pathname: string,
  req: HttpRequest,
  url: URL,
  res: ServerResponse,
  context: ApiContext,
): Promise<boolean> {
  const service = context.emailService;
  if (!service) return false;

  if (method === "GET" && pathname === "/api/email/inboxes") {
    json(res, { inboxes: service.listInboxes() });
    return true;
  }

  const checkMatch = pathname.match(/^\/api\/email\/inboxes\/([^/]+)\/check$/);
  if (method === "POST" && checkMatch) {
    try {
      const result = await service.checkInbox(decodeURIComponent(checkMatch[1]));
      json(res, result);
    } catch (err) {
      notFound(res);
    }
    return true;
  }

  const listMatch = pathname.match(/^\/api\/email\/inboxes\/([^/]+)\/messages$/);
  if (method === "GET" && listMatch) {
    const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 20;
    json(res, { messages: service.listMessages(decodeURIComponent(listMatch[1]), limit) });
    return true;
  }

  const messageMatch = pathname.match(/^\/api\/email\/messages\/([^/]+)$/);
  if (method === "GET" && messageMatch) {
    const message = service.getMessage(decodeURIComponent(messageMatch[1]));
    if (!message) {
      notFound(res);
      return true;
    }
    json(res, message);
    return true;
  }

  return false;
}
