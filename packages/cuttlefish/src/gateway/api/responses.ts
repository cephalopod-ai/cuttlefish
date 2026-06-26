import type { ServerResponse } from "node:http";
import { compressBuffer, MIN_COMPRESS_BYTES, pickEncoding } from "../compress.js";

/** Per-request Accept-Encoding, stashed by handleApiRequest so json() can compress. */
type ResWithEncoding = ServerResponse & { __acceptEncoding?: string };

export function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = Buffer.from(JSON.stringify(data));
  const enc =
    body.length >= MIN_COMPRESS_BYTES
      ? pickEncoding((res as ResWithEncoding).__acceptEncoding)
      : null;
  if (enc) {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Encoding": enc,
      Vary: "Accept-Encoding",
    });
    res.end(compressBuffer(enc, body));
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

export function notFound(res: ServerResponse): void {
  json(res, { error: "Not found" }, 404);
}

export function badRequest(res: ServerResponse, message: string): void {
  json(res, { error: message }, 400);
}

export function serverError(res: ServerResponse, message: string): void {
  json(res, { error: message }, 500);
}
