import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DEFAULT_JSON_BODY_MAX_BYTES, readJsonBody, readJsonObjectBody } from "../http-helpers.js";

function reqWithBody(body: string): IncomingMessage {
  const req = Readable.from([Buffer.from(body)]);
  return Object.assign(req, { headers: {} }) as unknown as IncomingMessage;
}

function resCapture() {
  const out: { status?: number; body?: unknown } = {};
  const res = {
    writeHead(status: number) {
      out.status = status;
      return this;
    },
    end(body?: string) {
      out.body = body ? JSON.parse(body) : undefined;
      return this;
    },
  } as unknown as ServerResponse;
  return { res, out };
}

describe("readJsonBody", () => {
  it("rejects bodies over the default JSON cap", async () => {
    const { res, out } = resCapture();
    const oversized = JSON.stringify({ value: "x".repeat(DEFAULT_JSON_BODY_MAX_BYTES + 1) });

    const parsed = await readJsonBody(reqWithBody(oversized), res);

    expect(parsed.ok).toBe(false);
    expect(out.status).toBe(413);
    expect(out.body).toEqual({ error: "Payload too large" });
  });

  it("allows a caller-provided larger cap when an endpoint explicitly needs it", async () => {
    const { res } = resCapture();
    const body = JSON.stringify({ value: "x".repeat(DEFAULT_JSON_BODY_MAX_BYTES + 1) });

    const parsed = await readJsonBody(reqWithBody(body), res, { maxBytes: body.length + 16 });

    expect(parsed).toEqual({ ok: true, body: JSON.parse(body) });
  });

  it("rejects non-object JSON bodies for object-only routes", async () => {
    const { res, out } = resCapture();

    const parsed = await readJsonObjectBody(reqWithBody(JSON.stringify([{ prompt: "x" }])), res);

    expect(parsed.ok).toBe(false);
    expect(out.status).toBe(400);
    expect(out.body).toEqual({ error: "Invalid JSON body: expected an object" });
  });
});
