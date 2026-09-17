import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import * as yaml from "js-yaml";
import type { ApiContext } from "../api.js";

const { home: tmpHome } = withStaticTempCuttlefishHome("cuttlefish-config-api-");

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

type Api = typeof import("../api.js");
type ConfigModule = typeof import("../../shared/config.js");

let api: Api;
let configModule: ConfigModule;

beforeAll(async () => {
  api = await import("../api.js");
  configModule = await import("../../shared/config.js");
});

beforeEach(() => {
  fs.mkdirSync(tmpHome, { recursive: true });
  fs.writeFileSync(
    path.join(tmpHome, "config.yaml"),
    yaml.dump({
      gateway: {
        port: 8888,
        host: "127.0.0.1",
        turnStallInactivityMs: 180000,
        turnStallCeilingMs: 2700000,
        turnStallRetries: 1,
      },
      engines: {
        default: "claude",
        claude: { bin: "claude", model: "opus" },
        codex: { bin: "codex", model: "gpt-5.5" },
      },
      connectors: {
        slack: {
          botToken: "xoxb-secret",
        },
      },
      logging: { file: true, stdout: true, level: "info" },
      workspaces: {
        roots: ["/tmp/project"],
        defaultCwd: "/tmp/project",
      },
      modelFallback: {
        enabled: true,
        defaultMode: "auto",
        globalChain: [{ engine: "codex", model: "gpt-5.5" }],
      },
      boardWorker: {
        enabled: true,
        idleMinutes: 30,
        timezone: "UTC",
        schedule: {
          weekday: { start: "22:00", end: "04:00" },
        },
        usage: { minRemainingPercent: 15 },
      },
    }),
  );
});

afterAll(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const headers = new Map<string, string>();
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    // The config routes stamp the revision header (UPS-A7), so the stub has to
    // accept headers the way a real ServerResponse does.
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), String(value));
      return this;
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },
  } as unknown as ServerResponse;
  return {
    res,
    header(name: string) {
      return headers.get(name.toLowerCase());
    },
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

function makeReq(method: string, urlPath: string, body?: unknown) {
  const req = body === undefined
    ? Readable.from([])
    : Readable.from([Buffer.from(JSON.stringify(body))]);
  return Object.assign(req, {
    method,
    url: urlPath,
    headers: { host: "localhost" },
  }) as unknown as Parameters<Api["handleApiRequest"]>[0];
}

describe("PUT /api/config", () => {
  it.each([
    ["malformed YAML", "gateway: [\n"],
    ["a sequence", "- unexpected\n"],
    ["a scalar", "unexpected\n"],
    ["an empty document", "\n"],
  ])("preserves an existing config containing %s", async (_kind, original) => {
    const currentConfig = configModule.loadConfig();
    const reloadConfig = vi.fn();
    const ctx = {
      getConfig: () => currentConfig, reloadConfig, emit: vi.fn(),
      sessionManager: { getEngine: () => undefined },
    } as unknown as ApiContext;
    const configPath = path.join(tmpHome, "config.yaml");
    // A valid unredacted snapshot reproduces the data-loss path even after the
    // old merge loses its original secret values. Sanitized GET parity is
    // asserted separately below.
    const snapshot = yaml.load(fs.readFileSync(configPath, "utf-8"));
    fs.writeFileSync(configPath, original);

    const response = makeRes();
    await api.handleApiRequest(makeReq("PUT", "/api/config", snapshot), response.res, ctx);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("CONFIG_INVALID_ON_DISK");
    expect(fs.readFileSync(configPath, "utf-8")).toBe(original);
    expect(reloadConfig).not.toHaveBeenCalled();
  });

  it("preserves an unreadable existing config instead of treating it as absent", async () => {
    const currentConfig = configModule.loadConfig();
    const configPath = path.join(tmpHome, "config.yaml");
    const snapshot = yaml.load(fs.readFileSync(configPath, "utf-8"));
    const reloadConfig = vi.fn();
    const ctx = {
      getConfig: () => currentConfig, reloadConfig, emit: vi.fn(),
      sessionManager: { getEngine: () => undefined },
    } as unknown as ApiContext;
    fs.unlinkSync(configPath);
    fs.mkdirSync(configPath);
    const marker = path.join(configPath, "preserve.txt");
    fs.writeFileSync(marker, "owned unreadable-config fixture");

    try {
      const response = makeRes();
      await api.handleApiRequest(makeReq("PUT", "/api/config", snapshot), response.res, ctx);
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("CONFIG_UNREADABLE");
      expect(fs.readFileSync(marker, "utf-8")).toBe("owned unreadable-config fixture");
      expect(reloadConfig).not.toHaveBeenCalled();
    } finally {
      fs.unlinkSync(marker);
      fs.rmdirSync(configPath);
    }
  });

  it("creates a genuinely absent config from a valid unredacted snapshot", async () => {
    const currentConfig = configModule.loadConfig();
    const configPath = path.join(tmpHome, "config.yaml");
    const snapshot = yaml.load(fs.readFileSync(configPath, "utf-8"));
    const reloadConfig = vi.fn();
    const ctx = {
      getConfig: () => currentConfig, reloadConfig, emit: vi.fn(),
      sessionManager: { getEngine: () => undefined },
    } as unknown as ApiContext;
    fs.unlinkSync(configPath);

    const response = makeRes();
    await api.handleApiRequest(makeReq("PUT", "/api/config", snapshot), response.res, ctx);

    expect(response.status).toBe(200);
    expect(yaml.load(fs.readFileSync(configPath, "utf-8"))).toEqual(snapshot);
    expect(reloadConfig).toHaveBeenCalledOnce();
  });

  it("accepts a full sanitized GET payload unchanged", async () => {
    let currentConfig = configModule.loadConfig();
    const ctx = {
      getConfig: () => currentConfig,
      reloadConfig: () => {
        currentConfig = configModule.loadConfig();
      },
      emit: vi.fn(),
      sessionManager: { getEngine: () => undefined },
    } as unknown as ApiContext;

    const getCap = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/config"), getCap.res, ctx);

    expect(getCap.status).toBe(200);
    expect(getCap.body).toMatchObject({
      workspaces: {
        roots: ["/tmp/project"],
        defaultCwd: "/tmp/project",
      },
      modelFallback: {
        enabled: true,
        defaultMode: "auto",
        globalChain: [{ engine: "codex", model: "gpt-5.5" }],
      },
      boardWorker: {
        enabled: true,
        idleMinutes: 30,
        timezone: "UTC",
        schedule: {
          weekday: { start: "22:00", end: "04:00" },
          weekend: { start: "22:00", end: "04:00" },
        },
        usage: { minRemainingPercent: 15 },
      },
      gateway: {
        turnStallInactivityMs: 180000,
        turnStallCeilingMs: 2700000,
        turnStallRetries: 1,
      },
      connectors: {
        slack: {
          botToken: "***",
        },
      },
    });

    const putCap = makeRes();
    await api.handleApiRequest(makeReq("PUT", "/api/config", getCap.body), putCap.res, ctx);

    expect(putCap.status).toBe(200);
    // The write hands back the revision it produced, so the page that just
    // saved is not stale against its own change (UPS-A7).
    expect(putCap.body).toEqual({ status: "ok", revision: expect.any(String) });
    expect(putCap.header("x-cuttlefish-config-revision")).toBe(putCap.body.revision);

    const saved = yaml.load(fs.readFileSync(path.join(tmpHome, "config.yaml"), "utf-8")) as Record<string, any>;
    expect(saved.workspaces).toEqual({
      roots: ["/tmp/project"],
      defaultCwd: "/tmp/project",
    });
    expect(saved.modelFallback).toEqual({
      enabled: true,
      defaultMode: "auto",
      globalChain: [{ engine: "codex", model: "gpt-5.5" }],
    });
    expect(saved.boardWorker).toEqual({
      enabled: true,
      idleMinutes: 30,
      timezone: "UTC",
      schedule: {
        weekday: { start: "22:00", end: "04:00" },
        weekend: { start: "22:00", end: "04:00" },
      },
      usage: { minRemainingPercent: 15 },
    });
    expect(saved.gateway).toMatchObject({
      turnStallInactivityMs: 180000,
      turnStallCeilingMs: 2700000,
      turnStallRetries: 1,
    });
    expect(saved.connectors).toMatchObject({
      slack: {
        botToken: "xoxb-secret",
      },
    });
  });

  it("rejects unknown top-level config keys through the shared validator", async () => {
    let currentConfig = configModule.loadConfig();
    const ctx = {
      getConfig: () => currentConfig,
      reloadConfig: () => {
        currentConfig = configModule.loadConfig();
      },
      emit: vi.fn(),
      sessionManager: { getEngine: () => undefined },
    } as unknown as ApiContext;

    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("PUT", "/api/config", {
        gateway: { port: 8888, host: "127.0.0.1" },
        engines: { claude: { bin: "claude", model: "opus" } },
        surprise: true,
      }),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(400);
    expect(cap.body).toMatchObject({
      error: expect.stringContaining("unknown config keys: surprise"),
    });
  });
});

describe("POST /api/onboarding — engine validation (DFI-005)", () => {
  it("rejects an unknown engine instead of writing it into engines.default unvalidated", async () => {
    let currentConfig = configModule.loadConfig();
    const ctx = {
      getConfig: () => currentConfig,
      reloadConfig: () => {
        currentConfig = configModule.loadConfig();
      },
      emit: vi.fn(),
      sessionManager: { getEngine: () => undefined },
    } as unknown as ApiContext;

    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/onboarding", { engine: "not-a-real-engine", model: "opus" }),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(400);
    expect(cap.body).toMatchObject({ error: expect.stringContaining("Unknown engine") });
    const saved = yaml.load(fs.readFileSync(path.join(tmpHome, "config.yaml"), "utf-8")) as Record<string, unknown>;
    expect((saved.engines as Record<string, unknown>).default).toBe("claude");
    expect((saved.portal as Record<string, unknown> | undefined)?.onboarded).not.toBe(true);
  });

  it("accepts a known engine and persists it", async () => {
    let currentConfig = configModule.loadConfig();
    const ctx = {
      getConfig: () => currentConfig,
      reloadConfig: () => {
        currentConfig = configModule.loadConfig();
      },
      emit: vi.fn(),
      sessionManager: { getEngine: () => undefined },
    } as unknown as ApiContext;

    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/onboarding", { engine: "codex", model: "gpt-5.5" }),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(200);
    const saved = yaml.load(fs.readFileSync(path.join(tmpHome, "config.yaml"), "utf-8")) as Record<string, unknown>;
    expect((saved.engines as Record<string, unknown>).default).toBe("codex");
    expect((saved.portal as Record<string, unknown>).onboarded).toBe(true);
  });
});
