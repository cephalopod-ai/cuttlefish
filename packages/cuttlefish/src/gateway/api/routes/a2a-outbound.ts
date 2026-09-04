import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { AgentCard, Message, StreamResponse, Task } from "@a2a-js/sdk";
import { readJsonObjectBody } from "../../http-helpers.js";
import { badRequest, json } from "../responses.js";
import type { ApiContext } from "../context.js";

const OUTBOUND_BODY_MAX_BYTES = 256 * 1024;

function decode(value: string): string | undefined {
  try { return decodeURIComponent(value); } catch { return undefined; }
}

function sendResultJson(result: Awaited<ReturnType<NonNullable<ApiContext["a2aOutbound"]>["send"]>>) {
  return "id" in result
    ? { kind: "task", task: Task.toJSON(result) }
    : { kind: "message", message: Message.toJSON(result) };
}

function outbound(context: ApiContext) {
  if (!context.a2aOutbound) throw new Error("Outbound A2A service is unavailable");
  return context.a2aOutbound;
}

export async function handleA2AOutboundRoutes(
  method: string,
  pathname: string,
  req: HttpRequest,
  res: ServerResponse,
  context: ApiContext,
): Promise<boolean> {
  const cardMatch = pathname.match(/^\/api\/a2a\/outbound\/([^/]+)\/card$/);
  if (method === "GET" && cardMatch) {
    const destinationId = decode(cardMatch[1]!);
    if (!destinationId) { badRequest(res, "Invalid A2A destination id"); return true; }
    json(res, agentCardJson(await outbound(context).discover(destinationId)));
    return true;
  }

  const sendMatch = pathname.match(/^\/api\/a2a\/outbound\/([^/]+)\/messages$/);
  if (method === "POST" && sendMatch) {
    const destinationId = decode(sendMatch[1]!);
    if (!destinationId) { badRequest(res, "Invalid A2A destination id"); return true; }
    const parsed = await readJsonObjectBody(req, res, { maxBytes: OUTBOUND_BODY_MAX_BYTES });
    if (!parsed.ok) return true;
    const body = parsed.body;
    if (typeof body.skillId !== "string" || typeof body.message !== "string") {
      badRequest(res, "skillId and message are required");
      return true;
    }
    const result = await outbound(context).send({
      destinationId,
      skillId: body.skillId,
      message: body.message,
      taskId: typeof body.taskId === "string" ? body.taskId : undefined,
      contextId: typeof body.contextId === "string" ? body.contextId : undefined,
      returnImmediately: body.returnImmediately === true,
      historyLength: typeof body.historyLength === "number" ? body.historyLength : undefined,
    });
    json(res, sendResultJson(result));
    return true;
  }

  const streamMatch = pathname.match(/^\/api\/a2a\/outbound\/([^/]+)\/messages:stream$/);
  if (method === "POST" && streamMatch) {
    const destinationId = decode(streamMatch[1]!);
    if (!destinationId) { badRequest(res, "Invalid A2A destination id"); return true; }
    const parsed = await readJsonObjectBody(req, res, { maxBytes: OUTBOUND_BODY_MAX_BYTES });
    if (!parsed.ok) return true;
    const body = parsed.body;
    if (typeof body.skillId !== "string" || typeof body.message !== "string") {
      badRequest(res, "skillId and message are required");
      return true;
    }
    const abort = new AbortController();
    res.on("close", () => { if (!res.writableEnded) abort.abort(new Error("Outbound A2A client disconnected")); });
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    try {
      for await (const event of outbound(context).sendStream({
        destinationId,
        skillId: body.skillId,
        message: body.message,
        taskId: typeof body.taskId === "string" ? body.taskId : undefined,
        contextId: typeof body.contextId === "string" ? body.contextId : undefined,
        historyLength: typeof body.historyLength === "number" ? body.historyLength : undefined,
        signal: abort.signal,
      })) {
        res.write(`data: ${JSON.stringify(StreamResponse.toJSON(event))}\n\n`);
      }
    } catch (error) {
      if (!res.writableEnded) res.write(`event: error\ndata: ${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n\n`);
    } finally {
      if (!res.writableEnded) res.end();
    }
    return true;
  }

  const taskMatch = pathname.match(/^\/api\/a2a\/outbound\/([^/]+)\/tasks\/([^/:]+)$/);
  if (method === "GET" && taskMatch) {
    const destinationId = decode(taskMatch[1]!);
    const taskId = decode(taskMatch[2]!);
    if (!destinationId || !taskId) { badRequest(res, "Invalid A2A destination or task id"); return true; }
    json(res, Task.toJSON(await outbound(context).getTask(destinationId, taskId)));
    return true;
  }

  const cancelMatch = pathname.match(/^\/api\/a2a\/outbound\/([^/]+)\/tasks\/([^/:]+):cancel$/);
  if (method === "POST" && cancelMatch) {
    const destinationId = decode(cancelMatch[1]!);
    const taskId = decode(cancelMatch[2]!);
    if (!destinationId || !taskId) { badRequest(res, "Invalid A2A destination or task id"); return true; }
    json(res, Task.toJSON(await outbound(context).cancelTask(destinationId, taskId)));
    return true;
  }

  return false;
}

function agentCardJson(card: Awaited<ReturnType<NonNullable<ApiContext["a2aOutbound"]>["discover"]>>) {
  return AgentCard.toJSON(card);
}
