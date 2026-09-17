import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { home: tmpHome } = withStaticTempCuttlefishHome("cuttlefish-start-test-");

const lifecycle = vi.hoisted(() => ({
  getStatus: vi.fn((): { running: boolean; pid: number; error?: string } => ({ running: true, pid: 123 })),
  restartDetached: vi.fn(() => true),
  startForeground: vi.fn(),
  startDaemon: vi.fn(),
  waitForPortListening: vi.fn(() => Promise.resolve(true)),
  readDaemonStartupLogTail: vi.fn((): string | null => null),
}));
const config = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ gateway: { host: "127.0.0.1", port: 8888 }, engines: { default: "claude" } })),
}));
const instances = vi.hoisted(() => ({
  ensureDefaultInstance: vi.fn(),
}));

vi.mock("../../gateway/lifecycle.js", () => lifecycle);
vi.mock("../../shared/config.js", () => config);
vi.mock("../instances.js", () => instances);
vi.mock("../../shared/version.js", () => ({
  compareSemver: () => 0,
  getPackageVersion: () => "1.0.0",
  getInstanceVersion: () => "1.0.0",
}));

const { runStart } = await import("../start.js");

beforeEach(() => {
  vi.clearAllMocks();
  lifecycle.restartDetached.mockReturnValue(true);
  config.loadConfig.mockReturnValue({ gateway: { host: "127.0.0.1", port: 8888 }, engines: { default: "claude" } });
  fs.mkdirSync(tmpHome, { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("runStart", () => {
  it("preserves invalid PID inspection guidance without suggesting a port change", async () => {
    lifecycle.getStatus.mockReturnValueOnce({ running: false, pid: 0, error: "Invalid gateway PID file; preserve and inspect its contents before retrying." });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const stopped = new Error("fixture process exit");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw stopped; });
    try {
      await expect(runStart({ daemon: true })).rejects.toBe(stopped);
      expect(exit).toHaveBeenCalledWith(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("preserve and inspect"));
      expect(error).not.toHaveBeenCalledWith(expect.stringContaining("free port"));
      expect(lifecycle.startDaemon).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it("names a safe remedy when an unowned process occupies the requested port", async () => {
    lifecycle.getStatus.mockReturnValueOnce({ running: false, pid: 0, error: "Port 8891 is occupied by PID 123, but no Cuttlefish PID file exists." });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const stopped = new Error("fixture process exit");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw stopped; });
    try {
      await expect(runStart({ daemon: true, port: 8891 })).rejects.toBe(stopped);
      expect(exit).toHaveBeenCalledWith(1);
      expect(lifecycle.getStatus).toHaveBeenCalledWith(8891);
      expect(lifecycle.startDaemon).not.toHaveBeenCalled();
      expect(lifecycle.startForeground).not.toHaveBeenCalled();
      expect(lifecycle.restartDetached).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.stringContaining("Port 8891 is occupied"));
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/free port.*cuttlefish start -p.*gateway\.port.*config\.yaml/));
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it("is idempotent when a gateway is already running", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runStart({ daemon: false });

    expect(lifecycle.restartDetached).not.toHaveBeenCalled();
    expect(lifecycle.getStatus).toHaveBeenCalledWith(8888);
    expect(instances.ensureDefaultInstance).toHaveBeenCalledWith(8888);
    expect(lifecycle.startForeground).not.toHaveBeenCalled();
    expect(lifecycle.startDaemon).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("Gateway already running.");
    log.mockRestore();
  });

  it("checks occupancy against the overridden port before starting", async () => {
    lifecycle.getStatus.mockReturnValueOnce({ running: false, pid: 0 });

    await runStart({ daemon: true, port: 8891 });

    expect(lifecycle.getStatus).toHaveBeenCalledWith(8891);
    expect(instances.ensureDefaultInstance).toHaveBeenCalledWith(8891);
    expect(lifecycle.startDaemon).toHaveBeenCalledTimes(1);
    expect(lifecycle.startDaemon).toHaveBeenCalledWith(expect.objectContaining({ gateway: expect.objectContaining({ port: 8891 }) }));
    expect(lifecycle.restartDetached).not.toHaveBeenCalled();
  });

  it("reports failure instead of claiming success when the daemon never becomes ready (REL-001)", async () => {
    lifecycle.getStatus.mockReturnValueOnce({ running: false, pid: 0 });
    lifecycle.waitForPortListening.mockResolvedValueOnce(false);
    lifecycle.readDaemonStartupLogTail.mockReturnValueOnce("Error: EADDRINUSE :8888");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      await runStart({ daemon: true });

      expect(lifecycle.startDaemon).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalledWith("Gateway started in background.");
      expect(error).toHaveBeenCalledWith(expect.stringContaining("did not become ready"));
      expect(error).toHaveBeenCalledWith(expect.stringContaining("EADDRINUSE"));
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("reports a clean error instead of a false success when startDaemon itself throws (REL-002)", async () => {
    lifecycle.getStatus.mockReturnValueOnce({ running: false, pid: 0 });
    lifecycle.startDaemon.mockImplementationOnce(() => {
      throw new Error("Could not find Node.js >= 24");
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      await runStart({ daemon: true });

      expect(log).not.toHaveBeenCalledWith("Gateway started in background.");
      expect(error).toHaveBeenCalledWith(expect.stringContaining("Could not find Node.js >= 24"));
      expect(lifecycle.waitForPortListening).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("prints a clean config error instead of letting Commander emit a stack trace", async () => {
    config.loadConfig.mockImplementationOnce(() => {
      throw new Error("config.yaml: gateway.port must be an integer from 1 to 65535");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      await runStart({ daemon: true });
      expect(error).toHaveBeenCalledWith(expect.stringContaining("gateway.port must be an integer"));
      expect(lifecycle.startDaemon).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      error.mockRestore();
    }
  });
});
