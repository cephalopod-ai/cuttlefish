import type { NextFunction, Request, Response } from "express";
import type { User } from "@a2a-js/sdk/server";
import type { CuttlefishConfig } from "../shared/types.js";
import { authenticateA2AClient } from "./config.js";
import { sendA2AHttpError } from "./errors.js";

const A2A_CLIENT_ID = Symbol("cuttlefish.a2a.clientId");

type A2ARequest = Request & { [A2A_CLIENT_ID]?: string };

export class A2AUser implements User {
  constructor(readonly userName: string) {}
  get isAuthenticated(): boolean { return true; }
}

function bearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

function requestCredential(req: Request): string {
  return bearerToken(req.header("authorization")) ?? req.header("x-api-key")?.trim() ?? "";
}

export function createA2AAuthMiddleware(getConfig: () => CuttlefishConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const config = getConfig();
    if (config.a2a?.enabled !== true) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const client = authenticateA2AClient(config, requestCredential(req));
    if (!client) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="cuttlefish-a2a"');
      sendA2AHttpError(res, {
        code: 401,
        status: "UNAUTHENTICATED",
        message: "A valid A2A credential is required",
      });
      return;
    }
    (req as A2ARequest)[A2A_CLIENT_ID] = client.id;
    next();
  };
}

export async function buildA2AUser(req: Request): Promise<User> {
  const clientId = (req as A2ARequest)[A2A_CLIENT_ID];
  if (!clientId) throw new Error("A2A authentication middleware did not establish a caller identity");
  return new A2AUser(clientId);
}
