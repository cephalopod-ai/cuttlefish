/**
 * Entry point for the DETACHED restart helper.
 * Spawned by lifecycle.ts restartDetached().
 *
 * Runs in its own reparented process (PPID 1), so it is immune to the gateway's
 * killAll() when the old gateway shuts down. Performs the restart out of band:
 *   stop the running gateway → wait for the port to free → start a fresh daemon.
 * The returning gateway resumes any sessions it marked "interrupted" on shutdown.
 */
import { loadConfig } from "../shared/config.js";
import { stopAndWait, startDaemon, waitForPortFree, waitForPortListening } from "./lifecycle.js";
import { logger } from "../shared/logger.js";

// stdio is ignored in detached mode — surface crashes to the log file instead of
// letting them vanish.
process.on("uncaughtException", (err) => {
  logger.error(`restart-entry uncaught exception: ${err?.stack ?? err}`);
});
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  logger.error(`restart-entry unhandled rejection: ${msg}`);
});

async function main(): Promise<void> {
  const config = loadConfig();
  const port = config.gateway?.port ?? 8888;

  logger.info("restart-entry: stopping current gateway…");
  // Waits for the old process to actually exit before removing the PID file,
  // so a concurrent start/status never sees "not running" while the port is
  // still held. Best-effort; no-op if already down.
  await stopAndWait(port);

  const freed = await waitForPortFree(port);
  if (!freed) {
    logger.warn(`restart-entry: port ${port} still bound after timeout — starting anyway`);
  }

  logger.info("restart-entry: starting fresh daemon…");
  startDaemon(config);
  const connectHost = !config.gateway?.host || config.gateway.host === "0.0.0.0" ? "127.0.0.1" : config.gateway.host;
  const listening = await waitForPortListening(port, connectHost);
  if (!listening) {
    logger.error(`restart-entry: fresh daemon did not bind port ${port} before timeout`);
    process.exitCode = 1;
    return;
  }
  logger.info("restart-entry: done");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`restart-entry failed: ${err instanceof Error ? err.stack : err}`);
    process.exit(1);
  });
