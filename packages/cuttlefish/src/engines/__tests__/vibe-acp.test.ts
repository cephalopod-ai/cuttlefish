// packages/cuttlefish/src/engines/__tests__/vibe-acp.test.ts
import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { HermesRpc } from "../hermes-jsonrpc.js";
import { VibeAcpEngine } from "../vibe-acp.js";

// ---------------------------------------------------------------------------
// Fake-server helpers (mirrors hermes-acp.test.ts — same ACP shape)
// ---------------------------------------------------------------------------

function fakeServer(onMessage?: (msg: Record<string, unknown>) => void) {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const rpc = new HermesRpc(toServer, fromServer);
  toServer.on("data", (b: Buffer) => {
    for (const line of b.toString().split("\n")) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as Record<string, unknown>;
      onMessage?.(msg);
      const reply = (result: unknown) =>
        fromServer.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
      const note = (params: unknown) =>
        fromServer.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params }) + "\n");
      if (msg.method === "initialize") reply({ protocolVersion: 1 });
      else if (msg.method === "session/new")
        reply({ sessionId: "V1", models: { currentModelId: "mistral-medium-3.5", availableModels: [] } });
      else if (msg.method === "session/load") reply({});
      else if (msg.method === "session/set_mode") reply({});
      else if (msg.method === "session/prompt") {
        const sid = ((msg.params as Record<string, unknown>)?.sessionId as string) ?? "V1";
        note({ sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } });
        note({ sessionId: sid, update: { sessionUpdate: "usage_update", size: 1000, used: 42 } });
        reply({ stopReason: "end_turn" });
      }
    }
  });
  return rpc;
}

class TestEngine extends VibeAcpEngine {
  protected spawnProc() {
    const rpc = fakeServer();
    return { rpc, killProc: () => {}, isAliveProc: () => true, onExit: (_cb: () => void) => {}, onError: (_cb: (e: Error) => void) => {} };
  }
}

describe("VibeAcpEngine.run", () => {
  it("streams text + context and returns the vibe session id", async () => {
    const eng = new TestEngine();
    const deltas: any[] = [];
    const r = await eng.run({ prompt: "hi", cwd: "/tmp", sessionId: "cuttlefish-1", onStream: (d) => deltas.push(d) });
    expect(r.sessionId).toBe("V1");
    expect(r.result).toBe("ok");
    expect(r.contextTokens).toBe(42);
    expect(deltas).toContainEqual({ type: "text", content: "ok" });
    expect(eng.isAlive("cuttlefish-1")).toBe(true);
  });

  it("prepends systemPrompt to prompt on a fresh (non-resume) session", async () => {
    let capturedPromptText = "";

    class SysPromptEngine extends VibeAcpEngine {
      protected spawnProc() {
        const rpc = fakeServer((msg) => {
          if (msg.method === "session/prompt") {
            const params = msg.params as Record<string, unknown>;
            const arr = params?.prompt as Array<{ text: string }> | undefined;
            capturedPromptText = arr?.[0]?.text ?? "";
          }
        });
        return { rpc, killProc: () => {}, isAliveProc: () => true, onExit: (_cb: () => void) => {}, onError: (_cb: (e: Error) => void) => {} };
      }
    }

    const eng = new SysPromptEngine();
    await eng.run({ prompt: "user question", cwd: "/tmp", sessionId: "sys-1", systemPrompt: "PERSONA-XYZ" });
    expect(capturedPromptText).toContain("PERSONA-XYZ");
    expect(capturedPromptText).toContain("user question");
  });

  it("resolves with error (not hangs) when handshake times out", async () => {
    class HangEngine extends VibeAcpEngine {
      protected handshakeTimeoutMs = 50;

      protected spawnProc() {
        const toServer = new PassThrough();
        const fromServer = new PassThrough();
        const rpc = new HermesRpc(toServer, fromServer);
        return { rpc, killProc: () => {}, isAliveProc: () => true, onExit: (_cb: () => void) => {}, onError: (_cb: (e: Error) => void) => {} };
      }
    }

    const eng = new HangEngine();
    const r = await eng.run({ prompt: "hi", cwd: "/tmp", sessionId: "cuttlefish-hang" });
    expect(r.error).toMatch(/handshake timeout/);
    expect(r.sessionId).toBe("");
    expect(r.result).toBe("");
    expect(eng.isAlive("cuttlefish-hang")).toBe(false);
  }, 5_000);

  it("rejects a second concurrent turn on the same session id", async () => {
    class SlowEngine extends VibeAcpEngine {
      protected spawnProc() {
        const toServer = new PassThrough();
        const fromServer = new PassThrough();
        const rpc = new HermesRpc(toServer, fromServer);
        toServer.on("data", (b: Buffer) => {
          for (const line of b.toString().split("\n")) {
            if (!line.trim()) continue;
            const msg = JSON.parse(line) as Record<string, unknown>;
            const reply = (result: unknown) =>
              fromServer.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
            if (msg.method === "initialize") reply({ protocolVersion: 1 });
            else if (msg.method === "session/new")
              reply({ sessionId: "V1", models: { currentModelId: "mistral-medium-3.5", availableModels: [] } });
            else if (msg.method === "session/set_mode") reply({});
            // session/prompt intentionally never replies — the first turn stays in flight.
          }
        });
        return { rpc, killProc: () => {}, isAliveProc: () => true, onExit: (_cb: () => void) => {}, onError: (_cb: (e: Error) => void) => {} };
      }
    }

    const eng = new SlowEngine();
    const firstTurn = eng.run({ prompt: "first", cwd: "/tmp", sessionId: "concurrent-1" });
    await new Promise((r) => setTimeout(r, 20));

    const second = await eng.run({ prompt: "second", cwd: "/tmp", sessionId: "concurrent-1" });
    expect(second.error).toMatch(/already running/);

    void firstTurn;
  });
});
