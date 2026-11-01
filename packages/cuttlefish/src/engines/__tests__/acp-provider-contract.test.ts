import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { HermesRpc } from "../hermes-jsonrpc.js";
import { HermesAcpEngine } from "../hermes-acp.js";
import { VibeAcpEngine } from "../vibe-acp.js";

interface FixtureOptions {
  modern?: boolean;
  advertiseModels?: boolean;
  rejectSelection?: boolean;
  acknowledgedModel?: string;
  promptError?: boolean;
  stopReason?: string;
  emptyLoadResult?: boolean;
}

/** Request-aware ACP peer: successful prompt text identifies the actual selected model. */
function providerFixture(Base: typeof VibeAcpEngine | typeof HermesAcpEngine, options: FixtureOptions = {}) {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let killed = 0;
  function spawnFixture() {
    const toServer = new PassThrough();
    const fromServer = new PassThrough();
    const rpc = new HermesRpc(toServer, fromServer);
    let actualModel = "default-model";
    const modelState = () => options.modern ? {
      configOptions: [{
        id: "provider-model-selector", name: "Model", category: "model", type: "select",
        currentValue: actualModel,
        options: [{ value: "default-model", name: "Default" }, { value: "requested-model", name: "Requested" }],
      }],
    } : { models: { currentModelId: actualModel, availableModels: [] } };
    toServer.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const message = JSON.parse(line);
        requests.push(message);
        const reply = (result: unknown) => fromServer.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
        const reject = () => fromServer.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Requested model unavailable" } }) + "\n");
        if (message.method === "initialize") reply({ protocolVersion: 1 });
        else if (message.method === "session/new") reply({ sessionId: "provider-session", ...(options.advertiseModels === false ? {} : modelState()) });
        else if (message.method === "session/load") reply(options.emptyLoadResult ? null : modelState());
        else if (message.method === "session/set_mode") reply({});
        else if (message.method === "session/set_config_option" || message.method === "session/set_model") {
          if (options.rejectSelection) { reject(); continue; }
          // Reject a method that this peer never advertised, so a legacy-only
          // mock cannot accidentally approve a modern adapter request.
          if (Boolean(options.modern) !== (message.method === "session/set_config_option")) { reject(); continue; }
          actualModel = options.acknowledgedModel ?? String(message.params.value ?? message.params.modelId);
          reply(options.modern ? modelState() : {});
        } else if (message.method === "session/prompt") {
          fromServer.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
            sessionId: "provider-session",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Answer from ${actualModel}` } },
          } }) + "\n");
          if (options.promptError) reject();
          else reply({ stopReason: options.stopReason ?? "end_turn" });
        }
      }
    });
    return { rpc, killProc: () => { killed++; }, isAliveProc: () => true, onExit: () => {}, onError: () => {} };
  }
  class FixtureVibe extends VibeAcpEngine {
    protected spawnProc = spawnFixture;
  }
  class FixtureHermes extends HermesAcpEngine {
    protected spawnProc = spawnFixture;
  }
  const engine = Base === VibeAcpEngine ? new FixtureVibe() : new FixtureHermes();
  return { engine, requests, killed: () => killed };
}

for (const Base of [VibeAcpEngine, HermesAcpEngine]) {
  describe(`${Base.name} provider contracts`, () => {
    it.each([false, true])("selects the advertised model protocol (modern=%s) before prompting", async (modern) => {
      const { engine, requests } = providerFixture(Base, { modern });
      const first = await engine.run({ prompt: "first", cwd: "/tmp", sessionId: "client", model: "requested-model" });
      const second = await engine.run({ prompt: "second", cwd: "/tmp", sessionId: "client", model: "requested-model" });
      expect(first.result).toBe("Answer from requested-model");
      expect(second.result).toBe("Answer from requested-model");
      expect(first.error).toBeUndefined();
      const modelCalls = requests.filter((r) => r.method === (modern ? "session/set_config_option" : "session/set_model"));
      expect(modelCalls).toHaveLength(1);
      expect(modelCalls[0].params).toEqual(modern
        ? { sessionId: "provider-session", configId: "provider-model-selector", value: "requested-model" }
        : { sessionId: "provider-session", modelId: "requested-model" });
      engine.killAll();
    });

    it("uses the model selector returned when loading a session", async () => {
      const { engine, requests } = providerFixture(Base, { modern: true });
      const result = await engine.run({ prompt: "resume", cwd: "/tmp", sessionId: "client", resumeSessionId: "provider-session", model: "requested-model" });
      expect(result.result).toBe("Answer from requested-model");
      expect(requests.some((r) => r.method === "session/load")).toBe(true);
      expect(requests.some((r) => r.method === "session/new")).toBe(false);
      engine.killAll();
    });

    it("preserves a resumed default-model session whose peer omits model metadata", async () => {
      const { engine, requests } = providerFixture(Base, { emptyLoadResult: true });
      const result = await engine.run({ prompt: "resume default", cwd: "/tmp", sessionId: "client", resumeSessionId: "provider-session" });
      expect(result.result).toBe("Answer from default-model");
      expect(result.error).toBeUndefined();
      expect(requests.some((r) => r.method === "session/new")).toBe(false);
      engine.killAll();
    });

    it.each([false, true])("rejects an unavailable model without prompting or caching rejection (modern=%s)", async (modern) => {
      const { engine, requests, killed } = providerFixture(Base, { modern, rejectSelection: true });
      for (let turn = 0; turn < 2; turn++) {
        const result = await engine.run({ prompt: "do not use wrong model", cwd: "/tmp", sessionId: "client", model: "requested-model" });
        expect(result.error).toContain("Requested model unavailable");
        expect(result.result).toBe("");
      }
      expect(requests.filter((r) => r.method === (modern ? "session/set_config_option" : "session/set_model"))).toHaveLength(2);
      expect(requests.some((r) => r.method === "session/prompt")).toBe(false);
      expect(killed()).toBe(2);
    });

    it("rejects a peer that acknowledges a different model", async () => {
      const { engine, requests } = providerFixture(Base, { modern: true, acknowledgedModel: "default-model" });
      const result = await engine.run({ prompt: "wrong preference", cwd: "/tmp", sessionId: "client", model: "requested-model" });
      expect(result.error).toContain('instead of requested "requested-model"');
      expect(requests.some((r) => r.method === "session/prompt")).toBe(false);
    });

    it("makes unsupported explicit selection visible", async () => {
      const { engine, requests } = providerFixture(Base, { advertiseModels: false });
      const result = await engine.run({ prompt: "wrong preference", cwd: "/tmp", sessionId: "client", model: "requested-model" });
      expect(result.error).toContain("does not advertise model selection");
      expect(requests.some((r) => r.method === "session/prompt")).toBe(false);
    });

    it("retains partial text and a rejected prompt error", async () => {
      const { engine } = providerFixture(Base, { promptError: true });
      const result = await engine.run({ prompt: "partial", cwd: "/tmp", sessionId: "client" });
      expect(result.result).toBe("Answer from default-model");
      expect(result.error).toContain("Requested model unavailable");
      engine.killAll();
    });

    it.each(["cancelled", "refusal"])("retains partial text and stop reason %s", async (stopReason) => {
      const { engine } = providerFixture(Base, { stopReason });
      const result = await engine.run({ prompt: "partial", cwd: "/tmp", sessionId: "client" });
      expect(result.result).toBe("Answer from default-model");
      expect(result.error).toContain(stopReason);
      engine.killAll();
    });
  });
}
