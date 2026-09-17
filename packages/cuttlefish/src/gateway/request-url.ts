import type { IncomingMessage } from "node:http";

/** Authorization and dispatch must interpret a request target identically. */
export function parseGatewayRequestUrl(req: Pick<IncomingMessage, "url" | "headers">): URL | null {
  try {
    return new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  } catch {
    return null;
  }
}
