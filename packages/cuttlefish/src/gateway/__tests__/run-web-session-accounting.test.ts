import { beforeEach, describe, expect, it, vi } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import { SessionQueue } from "../../sessions/queue.js";
import type { CuttlefishConfig, Engine } from "../../shared/types.js";
import fs from "node:fs";
import path from "node:path";

const { home } = withStaticTempCuttlefishHome("cuttlefish-web-session-accounting-");

function fakeEngine(run: Engine["run"], extra: Partial<Engine> = {}): Engine {
  return { name: "claude", run, ...extra } as Engine;
}

function writeEmployee(name: string, executionYaml: string): void {
  const dir = path.join(home, "org", "engineering");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.yaml`), [
    `name: ${name}`,
    `displayName: ${name}`,
    "department: engineering",
    "rank: employee",
    "engine: claude",
    "model: opus",
    "persona: Test employee.",
    "execution:",
    executionYaml.split("\n").map((line) => `  ${line}`).join("\n"),
    "",
  ].join("\n"));
}

async function setup() {
  const reg = await import("../../sessions/registry.js");
  const { recordSuccessfulWebSessionTurn, runWebSession } = await import("../run-web-session.js");
  reg.initDb();
  return { reg, recordSuccessfulWebSessionTurn, runWebSession };
}

describe("web-session turn accounting (PT-SC-04)", () => {
  beforeEach(async () => {
    fs.rmSync(home, { recursive: true, force: true });
    vi.resetModules();
  });

  it("records a completed direct web turn in the durable session total", async () => {
    const { reg, runWebSession } = await setup();
    const run = vi.fn<Engine["run"]>(async () => ({ result: "completed", sessionId: "engine-session", cost: 0.25, numTurns: 2 }));
    const engine = fakeEngine(run);
    const engines = new Map([["claude", engine]]);
    const config = {
      gateway: { host: "127.0.0.1", port: 8888 },
      engines: { default: "claude", claude: { bin: "node", model: "opus" } },
      portal: { portalName: "Cuttlefish" },
    } as unknown as CuttlefishConfig;
    const context = {
      getConfig: () => config,
      connectors: new Map(),
      emit: vi.fn(),
      sessionManager: {
        getEngine: () => engine,
        getEngines: () => engines,
        getQueue: () => new SessionQueue(),
      },
      startTime: Date.now(),
    } as any;
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:accounting-direct",
      sessionKey: "web:accounting-direct",
      prompt: "complete this turn",
    });
    reg.insertMessage(session.id, "user", "complete this turn");

    await runWebSession(session, "complete this turn", engine, config, context);

    expect(run).toHaveBeenCalledOnce();
    expect(reg.getSession(session.id)).toMatchObject({ totalCost: 0.25, totalTurns: 2, status: "idle" });
  });

  it("uses the same exactly-once rule for fallback and retry completions", async () => {
    const { reg, recordSuccessfulWebSessionTurn } = await setup();
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:accounting-recovery", prompt: "x" });

    recordSuccessfulWebSessionTurn(session.id, { cost: 0.1, numTurns: 1 });
    recordSuccessfulWebSessionTurn(session.id, {});
    recordSuccessfulWebSessionTurn(session.id, { error: "engine failed", cost: 5, numTurns: 5 });

    expect(reg.getSession(session.id)).toMatchObject({ totalCost: 0.1, totalTurns: 2 });
  });

  it("marks a turn errored when reported cost exceeds the employee execution budget", async () => {
    writeEmployee("budgeted", "tier: solo\nmaxEstimatedCostUsd: 0.01");
    const { reg, runWebSession } = await setup();
    const run = vi.fn<Engine["run"]>(async () => ({ result: "expensive result", sessionId: "engine-session", cost: 0.25, numTurns: 1 }));
    const engine = fakeEngine(run);
    const engines = new Map([["claude", engine]]);
    const config = {
      gateway: { host: "127.0.0.1", port: 8888 },
      engines: { default: "claude", claude: { bin: "node", model: "opus" } },
      portal: { portalName: "Cuttlefish" },
    } as unknown as CuttlefishConfig;
    const context = {
      getConfig: () => config,
      connectors: new Map(),
      emit: vi.fn(),
      sessionManager: {
        getEngine: () => engine,
        getEngines: () => engines,
        getQueue: () => new SessionQueue(),
      },
      startTime: Date.now(),
    } as any;
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:cost-budget",
      sessionKey: "web:cost-budget",
      employee: "budgeted",
      prompt: "complete this turn",
    });
    reg.insertMessage(session.id, "user", "complete this turn");

    await runWebSession(session, "complete this turn", engine, config, context);

    expect(reg.getSession(session.id)).toMatchObject({
      status: "error",
      lastError: expect.stringContaining("estimated cost $0.2500 is above limit $0.0100"),
    });
  });

  it("kills and errors a stream-visible turn that exceeds maxToolCalls", async () => {
    writeEmployee("tool-budgeted", "tier: solo\nmaxToolCalls: 1");
    const { reg, runWebSession } = await setup();
    const kill = vi.fn();
    const run = vi.fn<Engine["run"]>(async (opts) => {
      opts.onStream?.({ type: "tool_use", content: "Using first", toolName: "first" });
      opts.onStream?.({ type: "tool_use", content: "Using second", toolName: "second" });
      return { result: "used tools", sessionId: "engine-session", cost: 0.01, numTurns: 1 };
    });
    const engine = fakeEngine(run, { kill, isAlive: () => true, killAll: vi.fn(), killIdle: vi.fn() } as any);
    const engines = new Map([["claude", engine]]);
    const config = {
      gateway: { host: "127.0.0.1", port: 8888 },
      engines: { default: "claude", claude: { bin: "node", model: "opus" } },
      portal: { portalName: "Cuttlefish" },
    } as unknown as CuttlefishConfig;
    const context = {
      getConfig: () => config,
      connectors: new Map(),
      emit: vi.fn(),
      sessionManager: {
        getEngine: () => engine,
        getEngines: () => engines,
        getQueue: () => new SessionQueue(),
      },
      startTime: Date.now(),
    } as any;
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:tool-budget",
      sessionKey: "web:tool-budget",
      employee: "tool-budgeted",
      prompt: "complete this turn",
    });
    reg.insertMessage(session.id, "user", "complete this turn");

    await runWebSession(session, "complete this turn", engine, config, context);

    expect(kill).toHaveBeenCalledWith(session.id, "Interrupted: execution budget exceeded — tool-call limit (1) exceeded");
    expect(reg.getSession(session.id)).toMatchObject({
      status: "error",
      lastError: "Execution budget exceeded: tool-call limit (1) exceeded",
    });
  });
});
