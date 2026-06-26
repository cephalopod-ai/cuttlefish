/**
 * Entry point for the daemon child process.
 * Spawned by lifecycle.ts startDaemon().
 */
import { loadConfig } from "../shared/config.js";
import { startForeground } from "./lifecycle.js";
import { logger } from "../shared/logger.js";

// Safety-net: log uncaught exceptions / unhandled rejections instead of letting them
// silently kill the daemon process (stdio is ignored in daemon mode, so these would
// otherwise disappear with no trace).
process.on("uncaughtException", (err) => {
  logger.error(`Uncaught exception: ${err?.stack ?? err}`);
  // Do NOT re-throw or exit — keep the daemon alive.
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  logger.error(`Unhandled promise rejection: ${msg}`);
});

const config = loadConfig();
startForeground(config).catch((err) => {
  console.error("Daemon failed to start:", err);
  process.exit(1);
});
