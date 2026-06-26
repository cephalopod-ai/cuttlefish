import fs from "node:fs";
import readline from "node:readline";
import { assertSafeManagedInstanceHome, loadInstances, saveInstances } from "./instances.js";
import { probeProcess } from "../shared/pid.js";

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Poll until the process is definitively gone (ESRCH). Returns false on
 * timeout. EPERM or an unexpected error is NOT treated as gone — we keep
 * polling and let the caller time out rather than risk deleting a home
 * directory while the gateway is still alive.
 */
async function waitForPidExit(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probeProcess(pid) === "not-running") return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

export async function runNuke(name?: string): Promise<void> {
  const instances = loadInstances().filter((i) => i.name !== "cuttlefish");

  if (instances.length === 0) {
    console.log("No removable instances found. The default \"cuttlefish\" instance cannot be nuked.");
    return;
  }

  // If no name provided, show list and let user pick
  if (!name) {
    console.log("\nAvailable instances:\n");
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i];
      const homeDisplay = inst.home.replace(process.env.HOME || process.env.USERPROFILE || "", "~");
      console.log(`  ${DIM}${i + 1}.${RESET} ${inst.name} ${DIM}(${homeDisplay})${RESET}`);
    }
    console.log("");

    const choice = await ask("Select instance to nuke (number or name): ");

    // Try as number first
    const num = parseInt(choice, 10);
    if (!isNaN(num) && num >= 1 && num <= instances.length) {
      name = instances[num - 1].name;
    } else {
      name = choice;
    }
  }

  if (name === "cuttlefish") {
    console.error(`${RED}Error:${RESET} Cannot nuke the default "cuttlefish" instance.`);
    process.exit(1);
  }

  const allInstances = loadInstances();
  const index = allInstances.findIndex((i) => i.name === name);

  if (index === -1) {
    console.error(`${RED}Error:${RESET} Instance "${name}" not found.`);
    process.exit(1);
  }

  const instance = allInstances[index];
  let safeHome: string;
  try {
    safeHome = assertSafeManagedInstanceHome(instance);
  } catch (err) {
    console.error(`${RED}Error:${RESET} ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const homeDisplay = instance.home.replace(process.env.HOME || process.env.USERPROFILE || "", "~");

  // Check if running and stop it
  const pidFile = `${instance.home}/gateway.pid`;
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    const liveness = probeProcess(pid);
    if (liveness === "indeterminate") {
      console.error(`${RED}Error:${RESET} Cannot verify whether instance "${name}" is still running (PID file: ${DIM}${pidFile}${RESET}). Stop it and remove the PID file, then retry. Nothing was deleted.`);
      process.exit(1);
    }
    if (liveness === "running") {
      console.log(`\n${YELLOW}Instance "${name}" is running. Stopping it first...${RESET}`);
      process.kill(pid, "SIGTERM");
      // Wait until the process is actually dead — deleting the home directory
      // while the gateway is still shutting down would rip files out from
      // under it mid-write.
      const stopped = await waitForPidExit(pid);
      if (!stopped) {
        console.error(`${RED}Error:${RESET} Gateway process ${pid} is still running after 10s. Aborting — nothing was deleted. Stop it manually, then retry.`);
        process.exit(1);
      }
      console.log(`  Stopped.`);
    }
  }

  // Show warning
  console.log(`\n${RED}${BOLD}⚠  WARNING: THIS ACTION CANNOT BE UNDONE${RESET}\n`);
  console.log(`  This will permanently delete:`);
  console.log(`    • Instance "${name}" from the registry`);
  console.log(`    • All data in ${DIM}${homeDisplay}${RESET}`);
  console.log(`      ${DIM}(config, sessions, skills, org, logs — everything)${RESET}\n`);

  const confirmation = await ask(`Type "${BOLD}${name}${RESET}" to confirm: `);

  if (confirmation !== name) {
    console.log("\nAborted. Nothing was deleted.");
    return;
  }

  // Delete the home directory BEFORE persisting the registry removal. If the
  // delete fails (EPERM/EBUSY/EACCES — force only suppresses ENOENT), the
  // instance must remain in the registry so it stays manageable rather than
  // becoming an orphaned, half-deleted home that nothing can see.
  if (fs.existsSync(safeHome)) {
    try {
      fs.rmSync(safeHome, { recursive: true, force: true });
    } catch (err) {
      console.error(`${RED}Error:${RESET} Failed to delete ${DIM}${homeDisplay}${RESET}: ${err instanceof Error ? err.message : String(err)}`);
      console.error(`Instance "${name}" was left in the registry so it remains manageable. Resolve the issue and retry.`);
      process.exit(1);
    }
  }

  // Remove from registry only after the filesystem delete succeeded.
  allInstances.splice(index, 1);
  saveInstances(allInstances);

  console.log(`\n${RED}Instance "${name}" has been nuked.${RESET} ${DIM}${homeDisplay}${RESET} deleted.`);
}
