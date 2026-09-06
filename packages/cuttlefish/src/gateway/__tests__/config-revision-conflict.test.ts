import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import fs from "node:fs";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import * as yaml from "js-yaml";
import type { ApiContext } from "../api.js";

const { home: tmpHome } = withStaticTempCuttlefishHome("cuttlefish-config-revision-");

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

type Api = typeof import("../api.js");
type ConfigModule = typeof import("../../shared/config.js");

let api: Api;
let configModule: ConfigModule;
const configPath = () => path.join(tmpHome, "config.yaml");

const BASE_CONFIG = {
  gateway: { port: 8888, host: "127.0.0.1" },
  engines: { default: "claude", claude: { bin: "claude", model: "opus" } },
  logging: { file: true, stdout: true, level: "info" },
};

beforeAll(async () => {
  api = await import("../api.js");
  configModule = await import("../../shared/config.js");
});

beforeEach(() => {
  fs.mkdirSync(tmpHome, { recursive: true });
  fs.writeFileSync(configPath(), yaml.dump(BASE_CONFIG));
});

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const headers = new Map<string, string>();
  const res = {
    writeHead(s: number) { status = s; return this; },
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), String(value)); return this; },
    getHeader(name: string) { return headers.get(name.toLowerCase()); },
    end(buf?: Buffer | string) { if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); },
  } as unknown as ServerResponse;
  return {
    res,
    header: (name: string) => headers.get(name.toLowerCase()),
    get status() { return status; },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try { return JSON.parse(raw); } catch { return raw; }
    },
  };
}

function makeReq(method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}) {
  const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))]);
  return Object.assign(req, {
    method,
    url: urlPath,
    headers: { host: "localhost", ...headers },
  }) as unknown as Parameters<Api["handleApiRequest"]>[0];
}

function makeContext(): ApiContext {
  let currentConfig = configModule.loadConfig();
  return {
    getConfig: () => currentConfig,
    reloadConfig: () => { currentConfig = configModule.loadConfig(); },
    emit: vi.fn(),
    sessionManager: { getEngine: () => undefined },
  } as unknown as ApiContext;
}

const REV_HEADER = "x-cuttlefish-config-revision";

describe("config revision guard (UPS-A7)", () => {
  it("GET stamps a revision that changes only when the file changes", async () => {
    const ctx = makeContext();

    const first = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/config"), first.res, ctx);
    const second = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/config"), second.res, ctx);

    expect(first.header(REV_HEADER)).toBeTruthy();
    expect(second.header(REV_HEADER)).toBe(first.header(REV_HEADER));

    fs.writeFileSync(configPath(), yaml.dump({ ...BASE_CONFIG, gateway: { port: 9999, host: "127.0.0.1" } }));
    const third = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/config"), third.res, ctx);
    expect(third.header(REV_HEADER)).not.toBe(first.header(REV_HEADER));
  });

  it("refuses a save built on a stale view, and does not write", async () => {
    const ctx = makeContext();

    const get = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/config"), get.res, ctx);
    const staleRevision = get.header(REV_HEADER)!;

    // Somebody edits config.yaml at a terminal while the page sits open.
    const handEdited = { ...BASE_CONFIG, gateway: { port: 8888, host: "127.0.0.1", userHeader: "x-hand-edit" } };
    fs.writeFileSync(configPath(), yaml.dump(handEdited));

    const put = makeRes();
    await api.handleApiRequest(
      makeReq("PUT", "/api/config", { logging: { level: "debug" } }, { [REV_HEADER]: staleRevision }),
      put.res,
      ctx,
    );

    expect(put.status).toBe(409);
    expect(put.body.code).toBe("CONFIG_CONFLICT");
    // The current revision comes back so the page can adopt it without a
    // second round trip.
    expect(put.body.revision).toBe(put.header(REV_HEADER));
    expect(put.body.revision).not.toBe(staleRevision);

    // The hand edit survived, and the refused save left no trace.
    const onDisk = yaml.load(fs.readFileSync(configPath(), "utf-8")) as Record<string, never>;
    expect(onDisk).toEqual(handEdited);
  });

  it("accepts a save that carries the current revision", async () => {
    const ctx = makeContext();

    const get = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/config"), get.res, ctx);
    const revision = get.header(REV_HEADER)!;

    const put = makeRes();
    await api.handleApiRequest(
      makeReq("PUT", "/api/config", { logging: { level: "debug" } }, { [REV_HEADER]: revision }),
      put.res,
      ctx,
    );

    expect(put.status).toBe(200);
    expect(put.body.revision).not.toBe(revision);
    const onDisk = yaml.load(fs.readFileSync(configPath(), "utf-8")) as { logging: { level: string } };
    expect(onDisk.logging.level).toBe("debug");
  });

  it("leaves a revision-less save behaving exactly as before (partial-write opt-out)", async () => {
    const ctx = makeContext();
    fs.writeFileSync(configPath(), yaml.dump({ ...BASE_CONFIG, gateway: { port: 8888, host: "127.0.0.1", userHeader: "x-hand-edit" } }));

    const put = makeRes();
    await api.handleApiRequest(makeReq("PUT", "/api/config", { logging: { level: "warn" } }), put.res, ctx);

    expect(put.status).toBe(200);
    const onDisk = yaml.load(fs.readFileSync(configPath(), "utf-8")) as {
      logging: { level: string };
      gateway: { userHeader: string };
    };
    expect(onDisk.logging.level).toBe("warn");
    // A merge, not a clobber — the field it never saw is untouched.
    expect(onDisk.gateway.userHeader).toBe("x-hand-edit");
  });

  it("treats a revision claimed against a missing file as stale once one exists", async () => {
    const { ABSENT_CONFIG_REVISION } = await import("../config-revision.js");
    const ctx = makeContext();

    const put = makeRes();
    await api.handleApiRequest(
      makeReq("PUT", "/api/config", { logging: { level: "error" } }, { [REV_HEADER]: ABSENT_CONFIG_REVISION }),
      put.res,
      ctx,
    );
    expect(put.status).toBe(409);
  });
});
