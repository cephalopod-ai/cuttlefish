import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";

export class FileRequestError extends Error {}

export function readBody(req: HttpRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function badRequest(res: ServerResponse, message: string): void {
  json(res, { error: message }, 400);
}

export function notFound(res: ServerResponse): void {
  json(res, { error: "Not found" }, 404);
}

export function serverError(res: ServerResponse, message: string): void {
  json(res, { error: message }, 500);
}
