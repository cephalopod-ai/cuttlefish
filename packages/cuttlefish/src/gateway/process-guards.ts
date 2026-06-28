import { logger } from "../shared/logger.js";

let installed = false;

/**
 * Install process-level error boundaries so a single uncaught exception or
 * unhandled promise rejection does not bring down the entire gateway process.
 * Safe to call multiple times — handlers are only installed once.
 */
export function installProcessErrorHandlers(): void {
  if (installed) return;
  installed = true;
  process.on("uncaughtException", (err) => {
    logger.error(`Uncaught exception: ${err?.stack ?? err}`);
    // Do NOT re-throw or exit — keep the gateway (and the whole org) alive.
  });
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    logger.error(`Unhandled promise rejection: ${msg}`);
  });
}
