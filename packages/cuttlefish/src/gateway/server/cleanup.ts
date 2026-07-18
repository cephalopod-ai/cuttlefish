import type http from "node:http";
import fs from "node:fs";
import type { WebSocket, WebSocketServer } from "ws";
import type { Connector } from "../../shared/types.js";
import { logger } from "../../shared/logger.js";
import type { HookRegistry } from "../hook-registry.js";
import type { PtyLifecycleManager } from "../../engines/pty-lifecycle.js";
import type { OrchestrationRuntime } from "../../orchestration/runtime.js";

export type GatewayCleanup = () => Promise<void>;

interface GatewayCleanupDeps {
  claudeLifecycle: PtyLifecycleManager;
  connectors: Connector[];
  gatewayInfoFile: string;
  getRunningSessions: () => Array<{ id: string }>;
  hookRegistry: HookRegistry;
  interruptSession: (sessionId: string) => void;
  killEngines: () => void;
  orchestrationRuntime: OrchestrationRuntime | undefined;
  ptyWss: WebSocketServer;
  server: http.Server;
  stopBoardWorker: () => void;
  stopStuckTicketWatchdog: () => void;
  stopLeaderAckReconciler: () => void;
  stopScheduler: () => void;
  stopStatusReconciler: () => void;
  stopWatchers: () => Promise<void>;
  stopWsHeartbeat: () => void;
  uploadCleanupTimer: NodeJS.Timeout;
  mcpConfigSweepTimer?: NodeJS.Timeout;
  knowledgeRelayTimer?: NodeJS.Timeout;
  stopEmailService?: () => void;
  /** Release the macOS sleep assertion (no-op if not held). */
  stopSleepGuard?: () => void;
  /** Kill the Kokoro TTS sidecar (if one was spawned this session). */
  stopTts?: () => void;
  wsClients: Set<WebSocket>;
  wss: WebSocketServer;
}

export function createGatewayCleanup({
  claudeLifecycle,
  connectors,
  gatewayInfoFile,
  getRunningSessions,
  hookRegistry,
  interruptSession,
  killEngines,
  orchestrationRuntime,
  ptyWss,
  server,
  stopBoardWorker,
  stopStuckTicketWatchdog,
  stopLeaderAckReconciler,
  stopScheduler,
  stopStatusReconciler,
  stopWatchers,
  stopWsHeartbeat,
  uploadCleanupTimer,
  mcpConfigSweepTimer,
  knowledgeRelayTimer,
  stopEmailService,
  stopSleepGuard,
  stopTts,
  wsClients,
  wss,
}: GatewayCleanupDeps): GatewayCleanup {
  return async () => {
    logger.info("Gateway cleanup starting...");

    try {
      stopStatusReconciler();
    } catch (err) {
      logger.warn(`Failed to stop status reconciler: ${err instanceof Error ? err.message : err}`);
    }

    try {
      stopBoardWorker();
    } catch (err) {
      logger.warn(`Failed to stop board worker: ${err instanceof Error ? err.message : err}`);
    }

    try {
      stopStuckTicketWatchdog();
    } catch (err) {
      logger.warn(`Failed to stop stuck ticket watchdog: ${err instanceof Error ? err.message : err}`);
    }

    try {
      stopLeaderAckReconciler();
    } catch (err) {
      logger.warn(`Failed to stop leader ack reconciler: ${err instanceof Error ? err.message : err}`);
    }

    try {
      clearInterval(uploadCleanupTimer);
    } catch (err) {
      logger.warn(`Failed to clear upload cleanup timer: ${err instanceof Error ? err.message : err}`);
    }

    try {
      if (mcpConfigSweepTimer) clearInterval(mcpConfigSweepTimer);
    } catch (err) {
      logger.warn(`Failed to clear MCP config sweep timer: ${err instanceof Error ? err.message : err}`);
    }

    try {
      if (knowledgeRelayTimer) clearInterval(knowledgeRelayTimer);
    } catch (err) {
      logger.warn(`Failed to clear knowledge relay timer: ${err instanceof Error ? err.message : err}`);
    }

    try {
      stopEmailService?.();
    } catch (err) {
      logger.warn(`Failed to stop email service: ${err instanceof Error ? err.message : err}`);
    }

    try {
      stopTts?.();
    } catch (err) {
      logger.warn(`Failed to stop TTS sidecar: ${err instanceof Error ? err.message : err}`);
    }

    try {
      stopSleepGuard?.();
    } catch (err) {
      logger.warn(`Failed to release sleep guard: ${err instanceof Error ? err.message : err}`);
    }

    try {
      const runningSessions = getRunningSessions();
      for (const session of runningSessions) {
        try {
          interruptSession(session.id);
          logger.info(`Marked session ${session.id} as interrupted for resume`);
        } catch (err) {
          logger.warn(`Failed to mark session ${session.id} as interrupted: ${err instanceof Error ? err.message : err}`);
        }
      }
    } catch (err) {
      logger.warn(`Failed to enumerate running sessions: ${err instanceof Error ? err.message : err}`);
    }

    try {
      killEngines();
    } catch (err) {
      logger.error(`Failed to kill engines: ${err instanceof Error ? err.message : err}`);
    }

    try {
      await orchestrationRuntime?.prepareForShutdown("Interrupted: gateway shutting down gracefully");
    } catch (err) {
      logger.warn(`Failed to prepare orchestration runtime for shutdown: ${err instanceof Error ? err.message : err}`);
    }

    try {
      orchestrationRuntime?.close();
    } catch (err) {
      logger.warn(`Failed to close orchestration runtime: ${err instanceof Error ? err.message : err}`);
    }

    try {
      claudeLifecycle.dispose();
    } catch (err) {
      logger.warn(`Failed to dispose PTY lifecycle manager: ${err instanceof Error ? err.message : err}`);
    }

    try {
      hookRegistry.dispose();
    } catch (err) {
      logger.warn(`Failed to dispose hook registry: ${err instanceof Error ? err.message : err}`);
    }

    try {
      fs.rmSync(gatewayInfoFile, { force: true });
    } catch (err) {
      logger.warn(`Failed to remove ${gatewayInfoFile}: ${err instanceof Error ? err.message : err}`);
    }

    try {
      stopScheduler();
    } catch (err) {
      logger.warn(`Failed to stop scheduler: ${err instanceof Error ? err.message : err}`);
    }

    for (const connector of connectors) {
      try {
        await connector.stop();
      } catch (err) {
        logger.error(`Failed to stop ${connector.name} connector: ${err instanceof Error ? err.message : err}`);
      }
    }

    try {
      await stopWatchers();
    } catch (err) {
      logger.warn(`Failed to stop watchers: ${err instanceof Error ? err.message : err}`);
    }

    try {
      stopWsHeartbeat();
    } catch (err) {
      logger.warn(`Failed to stop WS heartbeat: ${err instanceof Error ? err.message : err}`);
    }

    for (const client of wsClients) {
      try {
        client.terminate();
      } catch (err) {
        logger.warn(`Failed to terminate WS client: ${err instanceof Error ? err.message : err}`);
      }
    }
    wsClients.clear();
    for (const client of ptyWss.clients) {
      try {
        client.terminate();
      } catch (err) {
        logger.warn(`Failed to terminate PTY WS client: ${err instanceof Error ? err.message : err}`);
      }
    }

    try {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    } catch (err) {
      logger.warn(`Failed to close WS server: ${err instanceof Error ? err.message : err}`);
    }

    try {
      await new Promise<void>((resolve) => ptyWss.close(() => resolve()));
    } catch (err) {
      logger.warn(`Failed to close PTY WS server: ${err instanceof Error ? err.message : err}`);
    }

    try {
      await new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.closeIdleConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    } catch (err) {
      logger.warn(`Failed to close HTTP server: ${err instanceof Error ? err.message : err}`);
    }

    logger.info("Gateway shutdown complete");
  };
}
