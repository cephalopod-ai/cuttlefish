import fs from "node:fs";
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import QRCode from "qrcode";
import type { IncomingMessage, Target } from "../../../shared/types.js";
import { TMP_DIR } from "../../../shared/paths.js";
import { redactText } from "../../../shared/redact.js";
import { WhatsAppConnector } from "../../../connectors/whatsapp/index.js";
import { readJsonBody } from "../../http-helpers.js";
import type { ApiContext } from "../context.js";
import { matchRoute } from "../match-route.js";
import { badRequest, json, notFound } from "../responses.js";

export async function handleConnectorRoutes(
  method: string,
  pathname: string,
  req: HttpRequest,
  res: ServerResponse,
  context: ApiContext,
): Promise<boolean> {
  let params = matchRoute("/api/connectors/:id/incoming", pathname);
  if (method === "POST" && params && params.id) {
    const connector = context.connectors.get(params.id) ?? (params.id === "discord" ? context.connectors.get("discord") : undefined);
    if (!connector) {
      notFound(res);
      return true;
    }
    if (!("deliverMessage" in connector)) {
      json(res, { error: "Discord connector is not in remote mode" }, 400);
      return true;
    }

    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as any;

    const { downloadAttachment } = await import("../../../connectors/discord/format.js");
    const attachments = await Promise.all(
      (body.attachments || []).map(async (att: { name: string; url: string; mimeType: string }) => {
        if (att.url) {
          try {
            const localPath = await downloadAttachment(att.url, TMP_DIR, att.name);
            return { name: att.name, url: att.url, mimeType: att.mimeType, localPath };
          } catch {
            return { name: att.name, url: att.url, mimeType: att.mimeType };
          }
        }
        return att;
      }),
    );

    const incomingMsg: IncomingMessage = {
      connector: params.id,
      source: "discord",
      sessionKey: body.sessionKey,
      channel: body.channel,
      thread: body.thread,
      user: body.user,
      userId: body.userId,
      text: body.text,
      messageId: body.messageId,
      attachments,
      replyContext: body.replyContext || {},
      transportMeta: body.transportMeta,
      raw: body,
    };

    (connector as any).deliverMessage(incomingMsg);
    json(res, { status: "delivered" });
    return true;
  }

  params = matchRoute("/api/connectors/:id/proxy", pathname);
  if (method === "POST" && params && params.id) {
    const connector = context.connectors.get(params.id) ?? (params.id === "discord" ? context.connectors.get("discord") : undefined);
    if (!connector) {
      notFound(res);
      return true;
    }
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as any;

    const action = body.action as string;
    const target = body.target as Target | undefined;
    let messageId: string | undefined;

    switch (action) {
      case "sendMessage":
        if (!target || !body.text) {
          badRequest(res, "target and text are required");
          return true;
        }
        messageId = (await connector.sendMessage(target, redactText(String(body.text)))) as string | undefined;
        break;
      case "replyMessage":
        if (!target || !body.text) {
          badRequest(res, "target and text are required");
          return true;
        }
        messageId = (await connector.replyMessage(target, redactText(String(body.text)))) as string | undefined;
        break;
      case "editMessage":
        if (!target || !body.text) {
          badRequest(res, "target and text are required");
          return true;
        }
        await connector.editMessage(target, redactText(String(body.text)));
        break;
      case "addReaction":
        if (!target || !body.emoji) {
          badRequest(res, "target and emoji are required");
          return true;
        }
        await connector.addReaction(target, body.emoji);
        break;
      case "removeReaction":
        if (!target || !body.emoji) {
          badRequest(res, "target and emoji are required");
          return true;
        }
        await connector.removeReaction(target, body.emoji);
        break;
      case "setTypingStatus":
        if (connector.setTypingStatus) {
          await connector.setTypingStatus(body.channelId ?? "", body.threadTs, body.status ?? "");
        }
        break;
      default:
        badRequest(res, `Unknown proxy action: ${action}`);
        return true;
    }

    json(res, { status: "ok", messageId });
    return true;
  }

  params = matchRoute("/api/connectors/:name/send", pathname);
  if (method === "POST" && params) {
    const connector = context.connectors.get(params.name);
    if (!connector) {
      notFound(res);
      return true;
    }
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as any;
    if (!body.channel || !body.text) {
      badRequest(res, "channel and text are required");
      return true;
    }
    await connector.sendMessage(
      { channel: body.channel, thread: body.thread },
      redactText(String(body.text)),
    );
    json(res, { status: "sent" });
    return true;
  }

  if (method === "POST" && pathname === "/api/connectors/reload") {
    if (!context.reloadConnectorInstances) {
      json(res, { error: "Connector reload not available" }, 501);
      return true;
    }
    try {
      const result = await context.reloadConnectorInstances();
      context.emit("connectors:reloaded", result);
      json(res, result);
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/connectors/whatsapp/qr") {
    const waConnector = context.connectors.get("whatsapp");
    if (!waConnector) {
      notFound(res);
      return true;
    }
    const qrString = (waConnector as WhatsAppConnector).getQrCode();
    if (!qrString) {
      json(res, { qr: null });
      return true;
    }
    const dataUrl = await QRCode.toDataURL(qrString, { width: 256, margin: 2 });
    json(res, { qr: dataUrl });
    return true;
  }

  if (method === "GET" && pathname === "/api/connectors") {
    const connectors = Array.from(context.connectors.entries()).map(([instanceId, connector]) => ({
      name: connector.name,
      instanceId,
      employee: connector.getEmployee?.() ?? undefined,
      ...connector.getHealth(),
    }));
    json(res, connectors);
    return true;
  }

  return false;
}
