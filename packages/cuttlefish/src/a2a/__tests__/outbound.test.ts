import { describe, expect, it, vi } from "vitest";
import {
  AgentCard,
  Task,
  TaskState,
  type AgentCard as AgentCardType,
} from "@a2a-js/sdk";
import type { CuttlefishConfig } from "../../shared/types.js";
import { OutboundA2AService } from "../outbound.js";

function card(interfaceUrl = "https://peer.example/a2a"): AgentCardType {
  return {
    name: "Peer",
    description: "Test peer",
    supportedInterfaces: [{ url: interfaceUrl, protocolBinding: "HTTP+JSON", protocolVersion: "1.0", tenant: "" }],
    provider: undefined,
    version: "1.0.0",
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false, extensions: [] },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [{
      id: "review-code",
      name: "Review code",
      description: "Reviews code",
      tags: ["review"],
      examples: [],
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
      securityRequirements: [],
    }],
    signatures: [],
  };
}

function config(): CuttlefishConfig {
  return {
    a2a: {
      destinations: [{
        id: "peer",
        agentCardUrl: "https://peer.example/.well-known/agent-card.json",
        token: "0123456789abcdef",
        allowedSkills: ["review-code"],
      }],
    },
  } as CuttlefishConfig;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/a2a+json" },
  });
}

describe("OutboundA2AService", () => {
  it("discovers and invokes only an allowed skill using confined bearer auth", async () => {
    const remoteTask: Task = {
      id: "remote-task-1",
      contextId: "remote-context-1",
      status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: "2026-09-02T00:00:00.000Z" },
      artifacts: [],
      history: [],
      metadata: {},
    };
    const guardedFetch = vi.fn(async (url: string, init: RequestInit, options: { allowedOrigins: ReadonlySet<string> }) => {
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer 0123456789abcdef");
      expect(options.allowedOrigins).toEqual(new Set(["https://peer.example"]));
      if (url.endsWith("agent-card.json")) return jsonResponse(AgentCard.toJSON(card()));
      if (url.endsWith("/message:send")) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
          message: {
            messageId: "stable-request-message-1",
            metadata: { skillId: "review-code" },
          },
        });
        return jsonResponse({ task: Task.toJSON(remoteTask) });
      }
      throw new Error(`unexpected request ${url}`);
    });
    const service = new OutboundA2AService(config, { guardedFetch });
    const result = await service.send({
      destinationId: "peer",
      skillId: "review-code",
      message: "Review this",
      messageId: "stable-request-message-1",
    });
    expect(result).toMatchObject({ id: "remote-task-1", status: { state: TaskState.TASK_STATE_COMPLETED } });
    expect(guardedFetch).toHaveBeenCalledTimes(2);
  });

  it("rejects card-advertised interfaces outside the destination origin allowlist", async () => {
    const guardedFetch = vi.fn(async () => jsonResponse(AgentCard.toJSON(card("https://redirected.example/a2a"))));
    const service = new OutboundA2AService(config, { guardedFetch });
    await expect(service.discover("peer")).rejects.toThrow(/no allowed HTTP\+JSON 1.0 interface/);
  });

  it("supports MADA-style x-api-key credentials without leaking bearer auth", async () => {
    const value = config();
    value.a2a!.destinations![0]!.credentialType = "x-api-key";
    const guardedFetch = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      expect(headers.get("x-api-key")).toBe("0123456789abcdef");
      expect(headers.get("authorization")).toBeNull();
      return jsonResponse(AgentCard.toJSON(card()));
    });
    const service = new OutboundA2AService(() => value, { guardedFetch });
    await service.discover("peer");
  });

  it("refuses cleartext credentials for a non-local peer at runtime", async () => {
    const value = config();
    Object.assign(value.a2a!.destinations![0]!, {
      agentCardUrl: "http://peer.example/.well-known/agent-card.json",
      allowedOrigins: ["http://peer.example"],
      allowPrivateHosts: true,
    });
    const guardedFetch = vi.fn();
    const service = new OutboundA2AService(() => value, { guardedFetch });

    await expect(service.discover("peer")).rejects.toThrow(/credentials require HTTPS/);
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("falls back to card-level output modes when an independent peer omits skill modes", async () => {
    const peerCard = card();
    delete (peerCard.skills[0] as Partial<typeof peerCard.skills[number]>).outputModes;
    const remoteTask: Task = {
      id: "remote-task-optional-modes",
      contextId: "remote-context-optional-modes",
      status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: "2026-09-02T00:00:00.000Z" },
      artifacts: [],
      history: [],
      metadata: {},
    };
    const guardedFetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("agent-card.json")) return jsonResponse(AgentCard.toJSON(peerCard));
      const body = JSON.parse(String(init.body)) as { configuration?: { acceptedOutputModes?: string[] } };
      expect(body.configuration?.acceptedOutputModes).toEqual(["text/plain"]);
      return jsonResponse({ task: Task.toJSON(remoteTask) });
    });
    const service = new OutboundA2AService(config, { guardedFetch });
    await expect(service.send({ destinationId: "peer", skillId: "review-code", message: "Review" }))
      .resolves.toMatchObject({ id: "remote-task-optional-modes" });
  });

  it("rejects skills not present in the per-destination allowlist before invocation", async () => {
    const guardedFetch = vi.fn(async () => jsonResponse(AgentCard.toJSON(card())));
    const service = new OutboundA2AService(config, { guardedFetch });
    await expect(service.send({ destinationId: "peer", skillId: "admin", message: "Do it" })).rejects.toThrow(/not allowlisted/);
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it("caches a validated card and rejects oversized outbound prompts", async () => {
    const value = config();
    value.a2a!.maxInputBytes = 1024;
    const guardedFetch = vi.fn(async () => jsonResponse(AgentCard.toJSON(card())));
    const service = new OutboundA2AService(() => value, { guardedFetch });
    await service.discover("peer");
    await service.discover("peer");
    expect(guardedFetch).toHaveBeenCalledTimes(1);
    await expect(service.send({ destinationId: "peer", skillId: "review-code", message: "x".repeat(1025) }))
      .rejects.toThrow(/input limit/);
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });
});
