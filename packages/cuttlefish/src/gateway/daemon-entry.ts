/**
 * Entry point for the daemon child process.
 * Spawned by lifecycle.ts startDaemon().
 */
import { loadConfig } from "../shared/config.js";
import type { CuttlefishConfig } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { loadPtyModule } from "../engines/pty-stream.js";
import { startForeground } from "./lifecycle.js";
import { installProcessErrorHandlers } from "./process-guards.js";

// Safety-net: log uncaught exceptions / unhandled rejections before startForeground
// installs them — covers the config-load window (stdio is ignored in daemon mode).
installProcessErrorHandlers();

let config: CuttlefishConfig;
try {
  config = loadConfig();
} catch (err) {
  console.error(`\n[cuttlefish] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

try {
  loadPtyModule();
  logger.info("Interactive PTY support loaded successfully during daemon startup");
} catch (err) {
  logger.warn(`Interactive PTY support is unavailable during startup: ${err instanceof Error ? err.message : String(err)}`);
}

startForeground(config).catch((err) => {
  console.error("Daemon failed to start:", err);
  process.exit(1);
});
