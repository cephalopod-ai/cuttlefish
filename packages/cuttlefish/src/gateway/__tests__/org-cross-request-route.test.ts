import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import type { Engine } from "../../shared/types.js";

const hoisted = vi.hoisted(() => ({
  dispatchEmployeeSessionRun: vi.fn(async () => {}),
}));

vi.mock("../mid-pair-orchestrator.js", () => ({
  dispatchEmployeeSessionRun: hoisted.dispatchEmployeeSessionRun,
}));

const testHome = withTempCuttlefishHome("cuttlefish-cross-request-");

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
  };
}

function makeJsonReq(method: string, urlPath: string, body: unknown) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as any;
  Object.assign(req, {
    method,
    url: urlPath,
    headers: {
      host: "localhost",
      "content-type": "application/json",
    },
  });
  return req;
}

function writeEmployee(department: string, name: string, yaml: string): void {
  const dir = path.join(testHome.home(), "org", department);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.yaml`), yaml.trimStart());
}

function makeCtx() {
  const engine: Engine = {
    name: "claude",
    run: async () => ({ result: "ok", sessionId: "engine-session" }),
  };
  return {
    getConfig: () => ({
      gateway: {},
      engines: { default: "claude", claude: { model: "sonnet" } },
      portal: { portalName: "Cuttlefish" },
    }),
    connectors: new Map(),
    startTime: Date.now(),
    emit: vi.fn(),
    sessionManager: {
      getEngine: () => engine,
      getEngines: () => new Map([["claude", engine]]),
      getQueue: () => ({
        enqueue: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()),
        getPendingCount: () => 0,
        getTransportState: (_key: string, status: string) => status,
        clearQueue: vi.fn(),
      }),
    },
  } as any;
}

async function setup() {
  vi.resetModules();
  const api = await import("../api.js");
  const reg = await import("../../sessions/registry.js");
  reg.initDb();
  return { api, reg };
}

beforeEach(() => {
  hoisted.dispatchEmployeeSessionRun.mockClear();
  writeEmployee("content", "content-writer", `
name: content-writer
displayName: Content Writer
department: content
rank: employee
engine: claude
model: sonnet
persona: Write content.
`);
  writeEmployee("platform", "platform-dev", `
name: platform-dev
displayName: Platform Dev
department: platform
rank: senior
engine: claude
model: opus
persona: Review frontend and backend code.
provides:
  - name: code-review
    description: Review PRs and provide feedback
`);
});

describe("POST /api/org/cross-request", () => {
  it("creates and dispatches a provider session for a discovered service", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx();
    const cap = makeRes();

    await api.handleApiRequest(makeJsonReq("POST", "/api/org/cross-request", {
      fromEmployee: "content-writer",
      service: "code-review",
      prompt: "Review the new blog template component",
    }), cap.res, ctx);

    expect(cap.status).toBe(201);
    expect(cap.body).toMatchObject({
      provider: {
        name: "platform-dev",
        displayName: "Platform Dev",
        department: "platform",
      },
      service: "code-review",
    });
    expect(cap.body.route).toContain("content-writer");
    expect(cap.body.route).toContain("platform-dev");

    const session = reg.getSession(cap.body.sessionId);
    expect(session).toMatchObject({
      employee: "platform-dev",
      engine: "claude",
      model: "opus",
      title: "Cross request: code-review",
    });
    const messages = reg.getMessages(cap.body.sessionId);
    expect(messages[0].content).toContain("## Cross-service request");
    expect(messages[0].content).toContain("**From**: Content Writer (content)");
    expect(messages[0].content).toContain("Review the new blog template component");
    expect(hoisted.dispatchEmployeeSessionRun).toHaveBeenCalledTimes(1);
  });

  it("returns 404 when the requested service is not provided", async () => {
    const { api } = await setup();
    const cap = makeRes();

    await api.handleApiRequest(makeJsonReq("POST", "/api/org/cross-request", {
      fromEmployee: "content-writer",
      service: "does-not-exist",
      prompt: "Need help",
    }), cap.res, makeCtx());

    expect(cap.status).toBe(404);
    expect(hoisted.dispatchEmployeeSessionRun).not.toHaveBeenCalled();
  });
});
