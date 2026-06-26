import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-cron-command-");

const triggerCronJob = vi.hoisted(() => vi.fn());

vi.mock("../../cron/scheduler.js", () => ({
  triggerCronJob,
  setCronJobEnabled: vi.fn(),
}));

vi.mock("../../shared/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

describe("SessionManager /cron run", () => {
  beforeEach(() => {
    vi.resetModules();
    triggerCronJob.mockReset();
  });

  it("replies with an overlap message when the manual cron trigger was skipped", async () => {
    const { SessionManager } = await import("../manager.js");
    triggerCronJob.mockResolvedValue({
      found: true,
      started: false,
      job: { id: "job-1", name: "Overlap" },
      run: {
        runId: "run-1",
        timestamp: "2026-06-23T10:00:00.000Z",
        startedAt: "2026-06-23T10:00:00.000Z",
        finishedAt: "2026-06-23T10:00:00.000Z",
        status: "skipped_overlap",
        trigger: "manual",
        error: "Previous run still in flight",
        resultPreview: null,
      },
    });

    const replyMessage = vi.fn().mockResolvedValue(undefined);
    const connector = {
      reconstructTarget: (target: Record<string, unknown>) => ({ ...target }),
      replyMessage,
    } as any;

    const manager = new SessionManager({
      engines: {
        default: "claude",
        claude: { model: "claude-sonnet-4-5" },
        codex: { model: "gpt-5-codex" },
      },
    } as any, new Map());

    const handled = await manager.handleCommand({
      text: "/cron run job-1",
      sessionKey: "cron-command-test",
      replyContext: {},
      source: "slack",
      connector: "slack",
    } as any, connector);

    expect(handled).toBe(true);
    expect(triggerCronJob).toHaveBeenCalledWith("job-1");
    expect(replyMessage).toHaveBeenCalledWith({}, 'Cron job "Overlap" already running; skipped overlap.');
  });
});
