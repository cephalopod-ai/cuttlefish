import { loadInstances, ensureDefaultInstance } from "./instances.js";
import { getStatus } from "../gateway/lifecycle.js";
import fs from "node:fs";
import path from "node:path";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export async function runList(): Promise<void> {
  ensureDefaultInstance();
  const instances = loadInstances();

  if (instances.length === 0) {
    console.log("No Cuttlefish instance found. Run \"cuttlefish setup\" to initialize ~/.cuttlefish.");
    return;
  }

  console.log("\nCuttlefish Instance\n");
  console.log(`  ${"Name".padEnd(16)} ${"Port".padEnd(8)} ${"Status".padEnd(12)} Home`);
  console.log(`  ${"─".repeat(16)} ${"─".repeat(8)} ${"─".repeat(12)} ${"─".repeat(30)}`);

  for (const inst of instances) {
    // Check if PID file exists and process is alive
    const pidFile = path.join(inst.home, "gateway.pid");
    let status = "stopped";
    if (fs.existsSync(pidFile)) {
      try {
        const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
        process.kill(pid, 0);
        status = "running";
      } catch {
        status = "stopped";
      }
    }

    const statusColor = status === "running" ? GREEN : RED;
    const homeDisplay = inst.home.replace(process.env.HOME || process.env.USERPROFILE || "", "~");
    console.log(
      `  ${inst.name.padEnd(16)} ${String(inst.port).padEnd(8)} ${statusColor}${status.padEnd(12)}${RESET} ${DIM}${homeDisplay}${RESET}`
    );
  }
  console.log("");
}
