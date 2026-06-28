/**
 * Entry point for the daemon child process.
 * Spawned by lifecycle.ts startDaemon().
 */
import { loadConfig } from "../shared/config.js";
import { startForeground } from "./lifecycle.js";
import { installProcessErrorHandlers } from "./process-guards.js";

// Safety-net: log uncaught exceptions / unhandled rejections before startForeground
// installs them — covers the config-load window (stdio is ignored in daemon mode).
installProcessErrorHandlers();

const config = loadConfig();
startForeground(config).catch((err) => {
  console.error("Daemon failed to start:", err);
  process.exit(1);
});
