import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CUTTLEFISH_HOME } from "../shared/paths.js";
import { safeWriteFile } from "../shared/safe-write.js";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SYSTEMD_USER_DIR = path.join(os.homedir(), ".config", "systemd", "user");
const SYSTEMD_SERVICE = path.join(SYSTEMD_USER_DIR, "cuttlefish.service");

function fatal(message: string): never {
  console.error(`${RED}Error:${RESET} ${message}`);
  process.exit(1);
}

function currentInstanceName(): string {
  return "cuttlefish";
}

function currentServiceName(): string {
  return "cuttlefish.service";
}

function currentUserName(): string {
  return process.env.USER || os.userInfo().username;
}

function cliEntryPath(): string {
  const bundled = path.resolve(__dirname, "..", "..", "bin", "cuttlefish.js");
  if (fs.existsSync(bundled)) return bundled;
  if (process.argv[1]) return path.resolve(process.argv[1]);
  fatal("Could not resolve the Cuttlefish CLI entrypoint path.");
}

function quoteSystemd(value: string): string {
  return JSON.stringify(value);
}

function requireLinuxSystemd(): void {
  if (process.platform !== "linux") {
    fatal("Startup integration is currently supported on Linux via systemd user services.");
  }
  try {
    execFileSync("systemctl", ["--user", "--version"], { stdio: "ignore" });
  } catch {
    fatal("systemctl --user is not available on this machine.");
  }
}

function ensureSetupExists(): void {
  if (!fs.existsSync(CUTTLEFISH_HOME)) {
    fatal(`${CUTTLEFISH_HOME} does not exist. Run "cuttlefish setup" first.`);
  }
}

function formatExecError(err: unknown): string {
  const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
  const stdout = typeof e.stdout === "string" ? e.stdout.trim() : e.stdout?.toString().trim();
  const stderr = typeof e.stderr === "string" ? e.stderr.trim() : e.stderr?.toString().trim();
  return stderr || stdout || e.message || String(err);
}

function runSystemctl(args: string[]): string {
  try {
    return execFileSync("systemctl", ["--user", ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    throw new Error(formatExecError(err));
  }
}

function systemctlState(args: string[]): string {
  try {
    return runSystemctl(args) || "unknown";
  } catch (err) {
    const msg = err instanceof Error ? err.message.trim() : String(err).trim();
    return msg || "unknown";
  }
}

function buildSystemdTemplate(): string {
  const nodeBin = process.execPath;
  const cuttlefishBin = cliEntryPath();
  const pathValue = process.env.PATH || "";
  return [
    "[Unit]",
    "Description=Cuttlefish gateway",
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${quoteSystemd(nodeBin)} ${quoteSystemd(cuttlefishBin)} start`,
    "Restart=on-failure",
    "RestartSec=3",
    "TimeoutStopSec=15",
    "WorkingDirectory=%h",
    `Environment=${quoteSystemd(`PATH=${pathValue}`)}`,
    "Environment=CUTTLEFISH_NO_OPEN=1",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function writeTemplateIfNeeded(): { path: string; changed: boolean } {
  fs.mkdirSync(SYSTEMD_USER_DIR, { recursive: true });
  const next = buildSystemdTemplate();
  const prev = fs.existsSync(SYSTEMD_SERVICE)
    ? fs.readFileSync(SYSTEMD_SERVICE, "utf-8")
    : null;
  if (prev === next) {
    return { path: SYSTEMD_SERVICE, changed: false };
  }
  safeWriteFile(SYSTEMD_SERVICE, next); // atomic + fsync (systemd unit)
  return { path: SYSTEMD_SERVICE, changed: true };
}

export async function runStartupEnable(): Promise<void> {
  ensureSetupExists();
  requireLinuxSystemd();

  const { path: templatePath, changed } = writeTemplateIfNeeded();
  const serviceName = currentServiceName();

  try {
    runSystemctl(["daemon-reload"]);
    runSystemctl(["enable", "--now", serviceName]);
  } catch (err) {
    fatal(`Failed to enable ${serviceName}: ${err instanceof Error ? err.message : err}`);
  }

  console.log(`${GREEN}Startup enabled.${RESET} ${serviceName} will start automatically when your user systemd session starts.`);
  console.log(`  Unit: ${DIM}${templatePath}${RESET}`);
  if (changed) {
    console.log(`  ${DIM}Updated the systemd unit with your current Node/Cuttlefish paths.${RESET}`);
  }
  console.log(`  ${YELLOW}Tip:${RESET} to start this even before login, run ${DIM}loginctl enable-linger ${currentUserName()}${RESET}`);
}

export async function runStartupDisable(): Promise<void> {
  requireLinuxSystemd();

  const serviceName = currentServiceName();
  const active = systemctlState(["is-active", serviceName]);
  const enabled = systemctlState(["is-enabled", serviceName]);

  if (enabled === "disabled" && active !== "active") {
    console.log(`Startup is already disabled for ${DIM}${serviceName}${RESET}.`);
    return;
  }

  try {
    runSystemctl(["disable", "--now", serviceName]);
  } catch (err) {
    fatal(`Failed to disable ${serviceName}: ${err instanceof Error ? err.message : err}`);
  }

  console.log(`${GREEN}Startup disabled.${RESET} ${serviceName} will no longer start automatically.`);
}

export async function runStartupStatus(): Promise<void> {
  requireLinuxSystemd();

  const serviceName = currentServiceName();
  const templateExists = fs.existsSync(SYSTEMD_SERVICE);
  const enabled = systemctlState(["is-enabled", serviceName]);
  const active = systemctlState(["is-active", serviceName]);

  console.log("Startup integration\n");
  console.log(`  Instance: ${DIM}${currentInstanceName()}${RESET}`);
  console.log(`  Service:  ${DIM}${serviceName}${RESET}`);
  console.log(`  Unit:     ${templateExists ? `${GREEN}installed${RESET}` : `${YELLOW}missing${RESET}`} ${DIM}${SYSTEMD_SERVICE}${RESET}`);
  console.log(`  Enabled:  ${DIM}${enabled}${RESET}`);
  console.log(`  Active:   ${DIM}${active}${RESET}`);

  if (!templateExists) {
    console.log(`\nRun ${DIM}cuttlefish startup enable${RESET} to install and enable startup.`);
  }
}
