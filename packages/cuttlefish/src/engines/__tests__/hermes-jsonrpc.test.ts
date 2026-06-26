// packages/cuttlefish/src/engines/__tests__/hermes-jsonrpc.test.ts
import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { HermesRpc } from "../hermes-jsonrpc.js";

function pair() {
  const toServer = new PassThrough(); // client stdin  (we write)
  const fromServer = new PassThrough(); // client stdout (we read)
  const rpc = new HermesRpc(toServer, fromServer);
  return { rpc, toServer, fromServer };
}

describe("HermesRpc", () => {
  it("resolves a request when a matching id result arrives", async () => {
    const { rpc, toServer, fromServer } = pair();
    const p = rpc.request("initialize", { protocolVersion: 1 });
    const sent = JSON.parse((toServer.read() as Buffer).toString());
    expect(sent).toMatchObject({ jsonrpc: "2.0", method: "initialize", id: sent.id });
    fromServer.write(JSON.stringify({ jsonrpc: "2.0", id: sent.id, result: { ok: true } }) + "\n");
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("dispatches notifications", async () => {
    const { rpc, fromServer } = pair();
    const seen: any[] = [];
    rpc.onNotification((m, params) => seen.push([m, params]));
    fromServer.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { x: 1 } }) + "\n");
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual([["session/update", { x: 1 }]]);
  });

  it("auto-answers a server→client request via onServerRequest", async () => {
    const { rpc, toServer, fromServer } = pair();
    rpc.onServerRequest(() => ({ outcome: { outcome: "selected", optionId: "allow_always" } }));
    fromServer.write(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 5));
    const reply = JSON.parse((toServer.read() as Buffer).toString());
    expect(reply).toMatchObject({ jsonrpc: "2.0", id: 99, result: { outcome: { optionId: "allow_always" } } });
  });

  it("rejectAll fails pending requests", async () => {
    const { rpc } = pair();
    const p = rpc.request("x", {});
    rpc.rejectAll(new Error("dead"));
    await expect(p).rejects.toThrow("dead");
  });
});
