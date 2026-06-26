/**
 * Process-liveness probing for destructive CLI operations.
 *
 * `process.kill(pid, 0)` does not send a signal; it only checks whether the
 * caller could signal the process. The error it throws is meaningful and must
 * not be swallowed indiscriminately:
 *
 *   - ESRCH  no such process — definitively gone.
 *   - EPERM  the process exists but we are not permitted to signal it (e.g. a
 *            recycled PID now owned by another user). It is NOT dead.
 *
 * Treating EPERM (or a non-numeric PID) as "not running" is dangerous for
 * destructive paths: it lets `remove`/`nuke` delete an instance home out from
 * under a live gateway. Only `ESRCH` proves the process is gone.
 */
export type Liveness = "running" | "not-running" | "indeterminate";

/**
 * Probe whether `pid` refers to a live process.
 *   - "running"        the process exists (signalable, or EPERM = exists but unowned)
 *   - "not-running"    ESRCH — no such process
 *   - "indeterminate"  invalid PID or an unexpected error — we cannot prove it is dead
 *
 * Callers in destructive paths must treat anything other than "not-running" as
 * "do not delete".
 */
export function probeProcess(pid: number): Liveness {
  if (!Number.isInteger(pid) || pid <= 0) return "indeterminate";
  try {
    process.kill(pid, 0);
    return "running";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "not-running";
    if (code === "EPERM") return "running";
    return "indeterminate";
  }
}
