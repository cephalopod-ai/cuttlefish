import { describe, expect, it, vi } from "vitest";
import type http from "node:http";
import type { WebSocket, WebSocketServer } from "ws";
import type { Connector } from "../../shared/types.js";
import type { HookRegistry } from "../hook-registry.js";
import type { PtyLifecycleManager } from "../../engines/pty-lifecycle.js";
import type { OrchestrationRuntime } from "../../orchestration/runtime.js";
import { createGatewayCleanup, type GatewayCleanup } from "../server/cleanup.js";

vi.mock("node:fs", () => ({
  default: { rmSync: vi.fn() },
  rmSync: vi.fn(),
}));

function fakeWss(): WebSocketServer {
  return {
    close: vi.fn((cb?: () => void) => cb?.()),
    clients: new Set<WebSocket>(),
  } as unknown as WebSocketServer;
}

function fakeServer(): http.Server {
  return {
    closeAllConnections: vi.fn(),
    closeIdleConnections: vi.fn(),
    close: vi.fn((cb?: (err?: Error) => void) => cb?.()),
  } as unknown as http.Server;
}

interface BuildOpts {
  stopBoardWorkerThrows?: boolean;
}

function build(opts: BuildOpts = {}) {
  const killEngines = vi.fn();
  const stopBoardWorker = vi.fn(() => {
    if (opts.stopBoardWorkerThrows) {
      throw new Error("board worker stop failed");
    }
  });

  const deps = {
    claudeLifecycle: { dispose: vi.fn() } as unknown as PtyLifecycleManager,
    connectors: [] as Connector[],
    gatewayInfoFile: "/tmp/gateway-info.json",
    getRunningSessions: vi.fn(() => []),
    hookRegistry: { dispose: vi.fn() } as unknown as HookRegistry,
    interruptSession: vi.fn(),
    killEngines,
    orchestrationRuntime: undefined as OrchestrationRuntime | undefined,
    ptyWss: fakeWss(),
    server: fakeServer(),
    stopBoardWorker,
    stopStuckTicketWatchdog: vi.fn(),
    stopLeaderAckReconciler: vi.fn(),
    stopScheduler: vi.fn(),
    stopStatusReconciler: vi.fn(),
    stopWatchers: vi.fn(async () => {}),
    stopWsHeartbeat: vi.fn(),
    uploadCleanupTimer: setInterval(() => {}, 1_000_000),
    stopEmailService: vi.fn(),
    stopSleepGuard: vi.fn(),
    stopTts: vi.fn(),
    wsClients: new Set<WebSocket>(),
    wss: fakeWss(),
  };

  const cleanup: GatewayCleanup = createGatewayCleanup(deps);
  clearInterval(deps.uploadCleanupTimer);
  return { cleanup, deps };
}

describe("createGatewayCleanup fault isolation", () => {
  it("still calls killEngines and completes when an early step throws", async () => {
    const { cleanup, deps } = build({ stopBoardWorkerThrows: true });

    await expect(cleanup()).resolves.toBeUndefined();

    expect(deps.stopBoardWorker).toHaveBeenCalledTimes(1);
    expect(deps.killEngines).toHaveBeenCalledTimes(1);
  });

  it("runs the full sequence to completion without throwing when no step fails", async () => {
    const { cleanup, deps } = build();

    await expect(cleanup()).resolves.toBeUndefined();

    expect(deps.stopStatusReconciler).toHaveBeenCalledTimes(1);
    expect(deps.stopBoardWorker).toHaveBeenCalledTimes(1);
    expect(deps.stopStuckTicketWatchdog).toHaveBeenCalledTimes(1);
    expect(deps.stopLeaderAckReconciler).toHaveBeenCalledTimes(1);
    expect(deps.stopEmailService).toHaveBeenCalledTimes(1);
    expect(deps.stopTts).toHaveBeenCalledTimes(1);
    expect(deps.stopSleepGuard).toHaveBeenCalledTimes(1);
    expect(deps.killEngines).toHaveBeenCalledTimes(1);
    expect(deps.stopScheduler).toHaveBeenCalledTimes(1);
    expect(deps.stopWatchers).toHaveBeenCalledTimes(1);
    expect(deps.stopWsHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("still calls killEngines when killEngines itself is downstream of a throwing sleep guard", async () => {
    const killEngines = vi.fn();
    const deps = {
      claudeLifecycle: { dispose: vi.fn() } as unknown as PtyLifecycleManager,
      connectors: [] as Connector[],
      gatewayInfoFile: "/tmp/gateway-info.json",
      getRunningSessions: vi.fn(() => [{ id: "session-1" }]),
      hookRegistry: { dispose: vi.fn() } as unknown as HookRegistry,
      interruptSession: vi.fn(() => {
        throw new Error("interrupt failed");
      }),
      killEngines,
      orchestrationRuntime: undefined as OrchestrationRuntime | undefined,
      ptyWss: fakeWss(),
      server: fakeServer(),
      stopBoardWorker: vi.fn(),
      stopStuckTicketWatchdog: vi.fn(),
      stopLeaderAckReconciler: vi.fn(),
      stopScheduler: vi.fn(),
      stopStatusReconciler: vi.fn(),
      stopWatchers: vi.fn(async () => {}),
      stopWsHeartbeat: vi.fn(),
      uploadCleanupTimer: setInterval(() => {}, 1_000_000),
      stopEmailService: vi.fn(),
      stopSleepGuard: vi.fn(() => {
        throw new Error("sleep guard release failed");
      }),
      stopTts: vi.fn(),
      wsClients: new Set<WebSocket>(),
      wss: fakeWss(),
    };
    const cleanup = createGatewayCleanup(deps);
    clearInterval(deps.uploadCleanupTimer);

    await expect(cleanup()).resolves.toBeUndefined();

    expect(killEngines).toHaveBeenCalledTimes(1);
  });
});
