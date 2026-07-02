import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import fs from "node:fs";
import path from "node:path";
import type { ServerResponse } from "node:http";

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

function makeReq(method: string, urlPath: string) {
  return { method, url: urlPath, headers: { host: "localhost" } } as any;
}

function makeCtx() {
  return {
    getConfig: () => ({ gateway: {}, engines: { default: "claude", claude: { bin: "claude", model: "opus" } } }),
    connectors: new Map(),
    startTime: Date.now(),
    emit: vi.fn(),
    reloadOrg: vi.fn(),
  } as any;
}

function writeEmployee(home: string, dept: string, name: string): void {
  const dir = path.join(home, "org", dept);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.yaml`),
    [`name: ${name}`, `displayName: ${name}`, `department: ${dept}`, "rank: employee", "engine: claude", "model: opus", `persona: ${name}`].join("\n"),
  );
}

const testHome = withTempCuttlefishHome("cuttlefish-org-board-route-");
let tmpHome: string;

beforeEach(() => {
  tmpHome = testHome.home();
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/org/departments/:name/board", () => {
  it("returns 200 with an empty board for a department that has no board.json yet", async () => {
    // Department exists (has an employee) but no board.json — a brand-new org.
    writeEmployee(tmpHome, "platform", "worker");
    expect(fs.existsSync(path.join(tmpHome, "org", "platform", "board.json"))).toBe(false);

    const api = await import("../api.js");
    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/org/departments/platform/board"), cap.res, makeCtx());

    // Empty board, not a 404 — this keeps the dashboard's per-department polling quiet.
    expect(cap.status).toBe(200);
    expect(cap.body).toMatchObject({ tickets: [], deletedTickets: [] });
    expect(typeof cap.body.retentionDays).toBe("number");
  });

  it("still 404s for a department directory that does not exist", async () => {
    const api = await import("../api.js");
    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/org/departments/does-not-exist/board"), cap.res, makeCtx());

    expect(cap.status).toBe(404);
  });
});
