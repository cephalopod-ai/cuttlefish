import fs from "node:fs";
import { assertSafeManagedInstanceHome, loadInstances, saveInstances } from "./instances.js";
import { probeProcess } from "../shared/pid.js";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export async function runRemove(name: string, opts: { force?: boolean }): Promise<void> {
  if (name === "cuttlefish") {
    console.error(`${RED}Error:${RESET} Cannot remove the default "cuttlefish" instance.`);
    process.exit(1);
  }

  const instances = loadInstances();
  const index = instances.findIndex((i) => i.name === name);

  if (index === -1) {
    console.error(`${RED}Error:${RESET} Instance "${name}" not found.`);
    process.exit(1);
  }

  const instance = instances[index];
  let safeHome: string | null = null;
  if (opts.force) {
    try {
      safeHome = assertSafeManagedInstanceHome(instance);
    } catch (err) {
      console.error(`${RED}Error:${RESET} ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  // Check if running. Only a definitive ESRCH ("not-running") permits cleanup;
  // EPERM or a garbage PID is treated as "still running / can't verify" so we
  // never delete the home out from under a live gateway.
  const pidFile = `${instance.home}/gateway.pid`;
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    const liveness = probeProcess(pid);
    if (liveness === "running") {
      console.error(`${RED}Error:${RESET} Legacy registry entry "${name}" is still running. Stop it before cleanup.`);
      process.exit(1);
    } else if (liveness === "indeterminate") {
      console.error(`${RED}Error:${RESET} Cannot verify whether "${name}" is still running (PID file: ${DIM}${pidFile}${RESET}). Stop it and remove the PID file, then retry.`);
      process.exit(1);
    }
  }

  if (opts.force) {
    // Delete the home directory BEFORE persisting the registry removal, so a
    // failed delete (EPERM/EBUSY/EACCES) leaves the instance registered and
    // manageable instead of orphaning a half-deleted home.
    let deleted = false;
    if (safeHome && fs.existsSync(safeHome)) {
      try {
        fs.rmSync(safeHome, { recursive: true, force: true });
        deleted = true;
      } catch (err) {
        console.error(`${RED}Error:${RESET} Failed to delete ${DIM}${safeHome}${RESET}: ${err instanceof Error ? err.message : String(err)}`);
        console.error(`Instance "${name}" was left in the registry so it remains manageable. Resolve the issue and retry.`);
        process.exit(1);
      }
    }
    instances.splice(index, 1);
    saveInstances(instances);
    if (deleted) {
      console.log(`${GREEN}Instance "${name}" removed.${RESET} Home directory ${DIM}${safeHome}${RESET} deleted.`);
    } else {
      console.log(`${GREEN}Instance "${name}" removed.${RESET} Home directory ${DIM}${safeHome}${RESET} was already absent.`);
    }
  } else {
    // Remove from registry
    instances.splice(index, 1);
    saveInstances(instances);

    console.log(`${GREEN}Instance "${name}" removed from registry.${RESET}`);
    if (fs.existsSync(instance.home)) {
      console.log(`  ${YELLOW}Note:${RESET} Home directory ${DIM}${instance.home}${RESET} still exists. Use --force to delete it.`);
    }
  }
}
