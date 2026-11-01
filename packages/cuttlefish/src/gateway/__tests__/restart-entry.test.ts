import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
  stopAndWait: vi.fn(),
  startDaemon: vi.fn(),
  waitForPortFree: vi.fn(),
  waitForPortListening: vi.fn(),
  releaseRestartLock: vi.fn(),
}));
vi.mock("../lifecycle.js", () => lifecycle);
vi.mock("../../shared/config.js", () => ({ loadConfig: () => ({ gateway: { port: 19001, host: "127.0.0.1" } }) }));
vi.mock("../../shared/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

let exitCode: typeof process.exitCode;
let exceptionListeners: ReturnType<typeof process.listeners>;
let rejectionListeners: ReturnType<typeof process.listeners>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  exitCode = process.exitCode;
  process.exitCode = 0;
  exceptionListeners = process.listeners("uncaughtException");
  rejectionListeners = process.listeners("unhandledRejection");
  lifecycle.stopAndWait.mockResolvedValue(true);
  lifecycle.waitForPortFree.mockResolvedValue(true);
  lifecycle.waitForPortListening.mockResolvedValue(true);
});

afterEach(() => {
  process.exitCode = exitCode;
  for (const listener of process.listeners("uncaughtException")) {
    if (!exceptionListeners.includes(listener)) process.removeListener("uncaughtException", listener);
  }
  for (const listener of process.listeners("unhandledRejection")) {
    if (!rejectionListeners.includes(listener)) process.removeListener("unhandledRejection", listener);
  }
});

async function runEntry(): Promise<void> {
  await import("../restart-entry.js");
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("detached restart outcome", () => {
  it("preserves failure when the new gateway never listens and releases the lock", async () => {
    lifecycle.waitForPortListening.mockResolvedValue(false);
    await runEntry();
    expect(process.exitCode).toBe(1);
    expect(lifecycle.releaseRestartLock).toHaveBeenCalledOnce();
  });

  it("keeps a successful restart successful and releases the lock", async () => {
    await runEntry();
    expect(process.exitCode).toBe(0);
    expect(lifecycle.startDaemon).toHaveBeenCalledOnce();
    expect(lifecycle.waitForPortListening).toHaveBeenCalledWith(19001, "127.0.0.1");
    expect(lifecycle.releaseRestartLock).toHaveBeenCalledOnce();
  });
});
