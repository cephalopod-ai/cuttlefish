import { describe, it, expect, beforeAll } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-att-");

type Files = typeof import("../files.js");
type Reg = typeof import("../../sessions/registry.js");

let files: Files;
let reg: Reg;

beforeAll(async () => {
  reg = await import("../../sessions/registry.js");
  files = await import("../files.js");
  reg.initDb();
  // Seed a session to attach to.
  const db = reg.initDb();
  db.prepare(
    "INSERT INTO sessions (id, engine, source, source_ref, status, created_at, last_activity) VALUES ('sess-att','claude','web','web:sess-att','idle','t','t')",
  ).run();
});

// Minimal fake req/res + context so we can drive the handler without a live server.
function fakeReq(body: string, contentType: string): import("node:http").IncomingMessage {
  const r = Readable.from([Buffer.from(body)]) as unknown as import("node:http").IncomingMessage;
  (r as unknown as { headers: Record<string, string> }).headers = { "content-type": contentType };
  return r;
}

function fakeRes() {
  const out: { status?: number; body?: string } = {};
  const res = {
    writeHead(status: number) { out.status = status; return res; },
    end(body?: string) { out.body = body; return res; },
  } as unknown as import("node:http").ServerResponse;
  return { res, out };
}

function fakeContext(events: Array<{ event: string; payload: unknown }>) {
  return {
    emit: (event: string, payload: unknown) => events.push({ event, payload }),
    getConfig: () => ({}),
  } as unknown as import("../api.js").ApiContext;
}

describe("handleSessionAttachment (JSON path mode)", () => {
  it("stores a session-scoped file, inserts an assistant message with media, and emits session:attachment", async () => {
    // Create a source file the "agent" produced.
    const src = path.join(tmp, "chart.png");
    fs.writeFileSync(src, Buffer.from("PNGDATA"));

    const events: Array<{ event: string; payload: unknown }> = [];
    const { res, out } = fakeRes();
    await files.handleSessionAttachment(
      fakeReq(JSON.stringify({ path: src, text: "the chart" }), "application/json"),
      res,
      "sess-att",
      fakeContext(events),
    );

    expect(out.status).toBe(201);
    const payload = JSON.parse(out.body!);
    expect(payload.media.type).toBe("image");
    expect(payload.media.url).toMatch(/^\/api\/files\//);

    // message persisted with media
    const msgs = reg.getMessages("sess-att");
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.content).toBe("the chart");
    expect(last.media?.[0].type).toBe("image");

    // file copied into the date-bucketed uploads dir, and servable by the guard
    const stored = payload.path as string;
    expect(files.isServablePath(stored)).toBe(true);
    expect(fs.existsSync(stored)).toBe(true);

    // WS event emitted for the UI
    const attach = events.find((e) => e.event === "session:attachment");
    expect(attach).toBeTruthy();
    expect((attach!.payload as { sessionId: string }).sessionId).toBe("sess-att");
  });

  it("rejects a JSON body with no source", async () => {
    const { res, out } = fakeRes();
    await files.handleSessionAttachment(
      fakeReq(JSON.stringify({ text: "nope" }), "application/json"),
      res,
      "sess-att",
      fakeContext([]),
    );
    expect(out.status).toBe(400);
  });
});
