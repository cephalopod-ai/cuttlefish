import type http from "node:http";
import express from "express";
import {
  DefaultExecutionEventBusManager,
  DefaultRequestHandler,
} from "@a2a-js/sdk/server";
import { agentCardHandler, restHandler } from "@a2a-js/sdk/server/express";
import type { ApiContext } from "../gateway/api/context.js";
import { buildA2AAgentCard } from "./card.js";
import { createA2AAuthMiddleware, buildA2AUser } from "./auth.js";
import { A2A_AGENT_CARD_PATH, A2A_BASE_PATH } from "./config.js";
import { CuttlefishA2AExecutor } from "./executor.js";
import { CuttlefishA2ARequestHandler } from "./request-handler.js";
import { SqliteA2ATaskStore } from "./store.js";
import { createA2ATaskProjector } from "./task-mapper.js";
import { sendA2AHttpError } from "./errors.js";

export interface CuttlefishA2AAdapter {
  handles(pathname: string): boolean;
  handle(req: http.IncomingMessage, res: http.ServerResponse): void;
}

function enabledGate(context: ApiContext) {
  return (_req: express.Request, res: express.Response, next: express.NextFunction): void => {
    if (context.getConfig().a2a?.enabled !== true) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    next();
  };
}

function httpJsonBoundary(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (["POST", "PUT", "PATCH"].includes(req.method)) {
    const raw = req.header("content-type");
    const mediaType = raw?.split(";", 1)[0]?.trim().toLowerCase();
    if (raw && mediaType !== "application/json" && mediaType !== "application/a2a+json") {
      sendA2AHttpError(res, {
        code: 415,
        status: "INVALID_ARGUMENT",
        message: `Unsupported Content-Type "${raw}"; expected application/json or application/a2a+json.`,
        reason: "CONTENT_TYPE_NOT_SUPPORTED",
      });
      return;
    }
  }

  const json = res.json.bind(res);
  res.json = ((body: unknown) => {
    // The A2A 1.0 HTTP+JSON binding requires application/json for both
    // successful and error envelopes. SSE routes set their own media type.
    res.type("application/json");
    return json(body);
  }) as typeof res.json;
  next();
}

export function createA2AAdapter(context: ApiContext): CuttlefishA2AAdapter {
  const app = express();
  app.disable("x-powered-by");

  const initialCard = buildA2AAgentCard(context.getConfig());
  let cardFingerprint = JSON.stringify(initialCard);
  let cardModifiedAt = new Date();
  const cardCacheHeaders = (_req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const currentFingerprint = JSON.stringify(buildA2AAgentCard(context.getConfig()));
    if (currentFingerprint !== cardFingerprint) {
      cardFingerprint = currentFingerprint;
      cardModifiedAt = new Date();
    }
    res.setHeader("Last-Modified", cardModifiedAt.toUTCString());
    next();
  };
  const store = new SqliteA2ATaskStore(undefined, createA2ATaskProjector(context));
  const executor = new CuttlefishA2AExecutor(store, context);
  const eventBuses = new DefaultExecutionEventBusManager();
  const defaultHandler = new DefaultRequestHandler(initialCard, store, executor, eventBuses);
  const handler = new CuttlefishA2ARequestHandler(
    defaultHandler,
    store,
    executor,
    async () => buildA2AAgentCard(context.getConfig()),
    eventBuses,
  );

  app.use(
    A2A_AGENT_CARD_PATH,
    enabledGate(context),
    cardCacheHeaders,
    agentCardHandler({ agentCardProvider: handler, cache: { maxAge: 30 } }),
  );
  app.use(
    A2A_BASE_PATH,
    enabledGate(context),
    createA2AAuthMiddleware(context.getConfig),
    httpJsonBoundary,
    express.json({ type: ["application/json", "application/a2a+json"], limit: "70mb", strict: false }),
    restHandler({ requestHandler: handler, userBuilder: buildA2AUser }),
  );
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));

  return {
    handles: (pathname) => pathname === A2A_AGENT_CARD_PATH || pathname === A2A_BASE_PATH || pathname.startsWith(`${A2A_BASE_PATH}/`),
    handle: (req, res) => { app(req, res); },
  };
}
