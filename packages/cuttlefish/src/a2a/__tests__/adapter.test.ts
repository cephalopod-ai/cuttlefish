import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { ApiContext } from "../../gateway/api/context.js";
import type { CuttlefishConfig } from "../../shared/types.js";
import { createA2AAdapter } from "../adapter.js";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function context(enabled: boolean): ApiContext {
  const config = {
    cuttlefish: { version: "1.2.3" },
    gateway: { host: "127.0.0.1", port: 8888 },
    a2a: {
      enabled,
      publicUrl: "https://gateway.example/a2a",
      allowedServices: ["test-only-service"],
      clients: [{ id: "partner-a", token: "0123456789abcdef" }],
    },
  } as CuttlefishConfig;
  return { getConfig: () => config } as ApiContext;
}

async function serve(adapter = createA2AAdapter(context(true))): Promise<string> {
  const server = http.createServer((req, res) => adapter.handle(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("A2A HTTP adapter", () => {
  it("serves a public A2A 1.0 Agent Card without exposing client credentials", async () => {
    const base = await serve();
    const response = await fetch(`${base}/.well-known/agent-card.json`);
    expect(response.status).toBe(200);
    const card = await response.json() as Record<string, unknown>;
    expect(card).toMatchObject({
      name: "Cuttlefish",
      supportedInterfaces: [{ url: "https://gateway.example/a2a", protocolBinding: "HTTP+JSON", protocolVersion: "1.0" }],
    });
    expect(response.headers.get("last-modified")).toMatch(/GMT$/);
    expect(JSON.stringify(card)).not.toContain("0123456789abcdef");
    expect(JSON.stringify(card)).not.toContain("partner-a");
  });

  it("requires a configured per-client identity on A2A methods", async () => {
    const base = await serve();
    const response = await fetch(`${base}/a2a/tasks/not-found`, { headers: { "A2A-Version": "1.0" } });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("accepts MADA-style x-api-key credentials and advertises both supported schemes", async () => {
    const base = await serve();
    const cardResponse = await fetch(`${base}/.well-known/agent-card.json`);
    const card = await cardResponse.json() as {
      securitySchemes: Record<string, { apiKeySecurityScheme?: { name?: string } }>;
      securityRequirements: Array<Record<string, unknown>>;
    };
    expect(JSON.stringify(card.securitySchemes)).toContain("x-api-key");
    expect(card.securityRequirements).toHaveLength(2);

    const response = await fetch(`${base}/a2a/tasks/not-found`, {
      headers: { "A2A-Version": "1.0", "x-api-key": "0123456789abcdef" },
    });
    expect(response.status).toBe(404);
  });

  it("returns not found for discovery when the adapter is disabled", async () => {
    const base = await serve(createA2AAdapter(context(false)));
    expect((await fetch(`${base}/.well-known/agent-card.json`)).status).toBe(404);
  });

  it("returns AIP-193 JSON and 415 for unsupported request media types", async () => {
    const base = await serve();
    const response = await fetch(`${base}/a2a/message:send`, {
      method: "POST",
      headers: {
        authorization: "Bearer 0123456789abcdef",
        "A2A-Version": "1.0",
        "content-type": "text/plain",
      },
      body: "not A2A JSON",
    });
    expect(response.status).toBe(415);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({
      error: {
        code: 415,
        status: "INVALID_ARGUMENT",
        details: [{ reason: "CONTENT_TYPE_NOT_SUPPORTED", domain: "a2a-protocol.org" }],
      },
    });
  });
});
