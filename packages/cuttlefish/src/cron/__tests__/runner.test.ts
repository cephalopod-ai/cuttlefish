import { describe, it, expect, vi, beforeEach } from "vitest";
import { runCronJob } from "../runner.js";
import type { CronJob, Connector, CuttlefishConfig } from "../../shared/types.js";

// Stub appendRunLog so we don't touch the filesystem
vi.mock("../jobs.js", () => ({
  appendRunLog: vi.fn(),
}));

// Stub org scanning
vi.mock("../../gateway/org.js", () => ({
  scanOrg: vi.fn(() => []),
  findEmployee: vi.fn(),
}));

// Stub logger
vi.mock("../../shared/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "test-job",
    name: "Test Job",
    enabled: true,
    schedule: "0 * * * *",
    prompt: "do something",
    ...overrides,
  };
}

function makeConfig(overrides: Partial<CuttlefishConfig["cron"]> = {}): CuttlefishConfig {
  return {
    engines: { default: "claude", claude: { model: "opus" } },
    logging: { file: false, stdout: false, level: "info" },
    cron: {
      alertConnector: "slack",
      alertChannel: "#cron-alerts",
      ...overrides,
    },
  } as CuttlefishConfig;
}

function makeMockConnector(): Connector {
  return {
    name: "slack",
    sendMessage: vi.fn().mockResolvedValue(undefined),
    replyMessage: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as Connector;
}

function makeMockSessionManager(delayMs = 0) {
  return {
    route: vi.fn().mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ sessionId: "sess-123" }), delayMs),
        ),
    ),
  } as any;
}

describe("runCronJob — latency alerting", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a Slack alert when job duration exceeds alertThresholdMs", async () => {
    const connector = makeMockConnector();
    const connectors = new Map<string, Connector>([["slack", connector]]);
    // Session takes 200ms, threshold is 100ms → should alert
    const sessionManager = makeMockSessionManager(200);
    const config = makeConfig({ alertThresholdMs: 100 });

    await runCronJob(makeJob(), sessionManager, config, connectors);

    expect(connector.sendMessage).toHaveBeenCalledWith(
      { channel: "#cron-alerts" },
      expect.stringContaining("Test Job"),
    );
    // Alert message should mention the duration
    const alertCall = (connector.sendMessage as any).mock.calls[0];
    expect(alertCall[1]).toMatch(/slow|latency|exceeded/i);
  });

  it("does NOT alert when job completes within alertThresholdMs", async () => {
    const connector = makeMockConnector();
    const connectors = new Map<string, Connector>([["slack", connector]]);
    // Session takes ~0ms, threshold is 5000ms → no alert
    const sessionManager = makeMockSessionManager(0);
    const config = makeConfig({ alertThresholdMs: 5000 });

    await runCronJob(makeJob(), sessionManager, config, connectors);

    expect(connector.sendMessage).not.toHaveBeenCalled();
  });

  it("does NOT alert when alertThresholdMs is not configured", async () => {
    const connector = makeMockConnector();
    const connectors = new Map<string, Connector>([["slack", connector]]);
    const sessionManager = makeMockSessionManager(0);
    const config = makeConfig(); // no alertThresholdMs

    await runCronJob(makeJob(), sessionManager, config, connectors);

    expect(connector.sendMessage).not.toHaveBeenCalled();
  });

  it("still logs success even when latency alert fires", async () => {
    const { appendRunLog } = await import("../jobs.js");
    const connector = makeMockConnector();
    const connectors = new Map<string, Connector>([["slack", connector]]);
    const sessionManager = makeMockSessionManager(200);
    const config = makeConfig({ alertThresholdMs: 100 });

    await runCronJob(makeJob(), sessionManager, config, connectors);

    expect(appendRunLog).toHaveBeenCalledWith(
      "test-job",
      expect.objectContaining({ status: "success" }),
    );
  });

  it("does not double-alert on failure (only failure alert, not latency)", async () => {
    const connector = makeMockConnector();
    const connectors = new Map<string, Connector>([["slack", connector]]);
    const sessionManager = {
      route: vi.fn().mockRejectedValue(new Error("API exploded")),
    } as any;
    const config = makeConfig({ alertThresholdMs: 1 });

    await runCronJob(makeJob(), sessionManager, config, connectors);

    // Should only get the failure alert, not a latency alert
    expect(connector.sendMessage).toHaveBeenCalledTimes(1);
    const alertMsg = (connector.sendMessage as any).mock.calls[0][1];
    expect(alertMsg).toContain("failed");
  });
});
