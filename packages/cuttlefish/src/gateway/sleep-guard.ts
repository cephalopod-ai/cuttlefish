import { spawn, type ChildProcess } from "node:child_process";
import { logger } from "../shared/logger.js";

/**
 * Demand-scoped macOS sleep assertion.
 *
 * The gateway used to spawn `caffeinate -s` unconditionally at boot, blocking
 * system sleep for its entire lifetime — an idle daemon kept the Mac awake
 * 24/7. This guard holds the assertion only while there is real work (running
 * sessions): `update(active)` acquires on the idle→active edge and releases on
 * active→idle, so the machine follows its normal standby rules whenever the
 * gateway is quiet. `-i` (prevent idle sleep) replaces `-s` so a lid close or
 * explicit sleep is always honored. Non-macOS platforms get a no-op guard —
 * Linux holds no inhibitor, matching prior behavior.
 */
export interface SleepGuard {
  /** Reconcile the assertion with current activity (idempotent). */
  update(active: boolean): void;
  /** Release and refuse further acquisitions (gateway shutdown). */
  stop(): void;
}

export function createSleepGuard(platform: NodeJS.Platform = process.platform): SleepGuard {
  if (platform !== "darwin") {
    return { update: () => {}, stop: () => {} };
  }

  let proc: ChildProcess | null = null;
  let stopped = false;

  const acquire = (): void => {
    if (proc || stopped) return;
    const child = spawn("caffeinate", ["-i"], { stdio: "ignore", detached: false });
    child.unref();
    child.on("error", (err) => {
      logger.warn(`caffeinate failed to start: ${err.message}`);
      if (proc === child) proc = null;
    });
    child.on("exit", () => {
      if (proc === child) proc = null;
    });
    proc = child;
    logger.info("caffeinate acquired — idle sleep deferred while sessions run");
  };

  const release = (): void => {
    if (!proc) return;
    const child = proc;
    proc = null;
    if (child.exitCode === null) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    logger.info("caffeinate released — system standby rules back in effect");
  };

  return {
    update(active: boolean): void {
      if (active) acquire();
      else release();
    },
    stop(): void {
      stopped = true;
      release();
    },
  };
}
