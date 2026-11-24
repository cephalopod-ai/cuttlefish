import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { buildEngineEnv } from "../shared/engine-env.js";
import { ENGINE_LINE_BUF_MAX } from "../shared/cap-append.js";
import { isPlainObject } from "../shared/plain-object.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { execFileCompat, killChildTree, spawnCompat } from "../shared/windows-exec.js";
import { HermesRpc } from "./hermes-jsonrpc.js";

export const MUSE_VERSION = "1.4.25";
export const MUSE_VERSION_PATTERN = new RegExp(`^Muse Code ${MUSE_VERSION.replaceAll(".", "\\.")}(?:\\s|$)`);
const REQUEST_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 750;

export function museRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

export function museCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function museEnvironment(): Record<string, string> {
  const env = buildEngineEnv({ NO_COLOR: "1" });
  for (const key of Object.keys(env)) {
    const name = key.toUpperCase();
    // Filter scoped additions as well as ambient variables. Muse must select a
    // stored browser login and must keep the posture set by the adapter.
    if (name === "META_API_KEY" || name === "MODEL_API_KEY"
      || name === "CUTTLEFISH_SESSION_TOKEN" || name.startsWith("MUSE_") || name.startsWith("TBH_")) {
      delete env[key];
    }
  }
  return env;
}

const HOST_ARGS = [
  "serve", "--provider", "meta", "--contributor-mode", "off",
  "--disable-request-user-input",
  "-c", "endpoint_transport=null",
  "-c", "run.workflow_trigger_mode=\"off\"",
  "-c", "agents.execution_capacity=1",
  "-c", "runtime_capabilities.reminder_agents=false",
  "-c", "run.toolset=[\"read_file\",\"bash\"]",
  "-c", "tools.web_search.mode=\"off\"",
  "-c", "tools.web_fetch.enabled=false",
  "-c", "tools.artifact.enabled=false",
  "-c", "plugins.enabled=false",
  "-c", "managed_hooks_path=null",
];

async function verifyUserSettings(home: string): Promise<void> {
  const file = await open(path.join(home, "settings.json"), "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw new Error("Muse user settings could not be inspected.");
  });
  if (!file) return;
  try {
    const size = (await file.stat()).size;
    if (size > ENGINE_LINE_BUF_MAX) throw new Error("Muse settings are too large to inspect.");
    const settings = parseConfigJson(await file.readFile("utf8"), "user settings");
    if (!isPlainObject(settings)) throw new Error("Muse settings must be a JSON object.");
    if (Object.keys(museRecord(settings.hooks)).length || settings.managed_hooks_path
      || settings.endpoint_transport || settings.endpointTransport) {
      throw new Error("Muse user hooks and endpoint overrides are incompatible with Cuttlefish dispatch.");
    }
  } finally {
    await file.close();
  }
}

function parseConfigJson(text: string, subject: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Muse ${subject} returned invalid JSON.`);
  }
}

async function verifyWorkspaceSettings(cwd: string): Promise<void> {
  // A previously trusted workspace can have startup hooks. A session inventory
  // only becomes available after startup, so check project hook files first.
  for (let parent = cwd; ; parent = path.dirname(parent)) {
    for (const filename of ["hooks.json", "settings.json"]) {
      const exists = await lstat(path.join(parent, ".muse", filename))
        .then(() => true, (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw new Error("Muse workspace configuration could not be inspected.");
        });
      if (exists) throw new Error("Muse workspace hooks or settings require separate qualification.");
    }
    if (path.dirname(parent) === parent) return;
  }
}

export type MuseAuthStatus = "subscription" | "api_key" | "signed_out" | "no_subscription" | "unknown";

export interface MuseSubscription {
  status: MuseAuthStatus;
  tier?: string;
  observedAtMs?: number;
  windows?: { name: string; usedPercent: number; durationMins: number; resetsAtMs: number }[];
}

function parseAllowance(value: unknown): Pick<MuseSubscription, "observedAtMs" | "windows"> {
  const allowance = museRecord(value);
  const observedAtMs = museCount(allowance.observedAtMs);
  if (!observedAtMs || observedAtMs > Date.now() + 60_000) return {};
  const windows = [];
  for (const [name, raw] of [["window", allowance.window], ["weekly", allowance.weekly]] as const) {
    const row = museRecord(raw);
    const usedPercent = museCount(row.usedPercent);
    const resetsAtMs = museCount(row.resetsAtMs);
    const durationMins = name === "weekly" ? 10_080 : museCount(row.windowDurationMins);
    if (usedPercent === undefined || !resetsAtMs || resetsAtMs > 8.64e15 || !durationMins) return {};
    windows.push({ name, usedPercent, resetsAtMs, durationMins });
  }
  return { observedAtMs, windows };
}

export class MuseHost {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly rpc: HermesRpc;
  private readonly closed: Promise<void>;
  private stopped?: Error;
  private exited = false;
  private stopListeners = new Set<(error: Error) => void>();
  private readonly bin: string;
  private readonly env = museEnvironment();

  constructor(private cwd: string, override?: string) {
    this.bin = resolveBin("muse", override);
    this.proc = spawnCompat(this.bin, HOST_ARGS, {
      cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    // Provider stderr and RPC error messages can contain user configuration,
    // inline tool input or endpoint details. Drain stderr and report a safe cause.
    this.proc.stderr.resume();
    this.rpc = new HermesRpc(this.proc.stdin, this.proc.stdout, {
      maxFrameBytes: ENGINE_LINE_BUF_MAX,
      onError: (error) => this.stop(error.message),
    });
    this.proc.stdin.on("error", () => this.stop("Muse protocol input closed unexpectedly"));
    this.proc.stdout.on("error", () => this.stop("Muse protocol output closed unexpectedly"));
    this.proc.once("error", () => this.stop("Muse executable could not start. Check engines.muse.bin and the workspace directory."));
    this.closed = new Promise((resolve) => {
      this.proc.once("exit", () => { this.exited = true; });
      this.proc.once("close", () => {
        this.exited = true;
        this.stop("Muse process closed before the requested operation completed");
        resolve();
      });
    });
  }

  async initialize(workspace?: string): Promise<void> {
    const result = await this.request("initialize", {
      clientInfo: { name: "cuttlefish", version: "1" },
      capabilities: { experimentalApi: true, userInputDialogs: false },
    });
    const server = museRecord(result.serverInfo);
    if (server.name !== "muse" || server.version !== MUSE_VERSION
      || museRecord(result.schema).version !== 1 || result.experimentalApi !== true
      || result.sessionDurability !== "durable") {
      throw new Error(`Muse protocol unavailable. Install the qualified Muse Code ${MUSE_VERSION} executable.`);
    }
    if (result.sandboxAvailability !== "available") {
      throw new Error("Muse sandbox is unavailable on this host");
    }
    this.rpc.notify("initialized");
    if (typeof result.museHome !== "string" || !path.isAbsolute(result.museHome)) {
      throw new Error("Muse did not identify its native settings directory.");
    }
    await verifyUserSettings(result.museHome);
    if (workspace) await verifyWorkspaceSettings(workspace);
    await this.verifyManagedSettings();
  }

  private async verifyManagedSettings(): Promise<void> {
    const status = parseConfigJson(await this.cliOutput(["config", "status", "--json"], "managed configuration status"), "managed configuration status");
    const sources = museRecord(status).sources;
    if (!Array.isArray(sources) || !sources.length || !sources.every((source) => museRecord(source).state === "absent")) {
      throw new Error("Muse managed configuration requires separate qualification.");
    }
  }

  async modelIds(): Promise<string[]> {
    this.assertActive();
    const stdout = await this.cliOutput(["exec", "--provider", "meta", "--contributor-mode", "off", "--list-models"], "model catalog");
    return [...new Set(stdout.split(/\r?\n/).map((line) => line.trim())
      .filter((line) => /^muse-[a-z0-9][a-z0-9.-]{0,95}$/.test(line) && !line.endsWith("-contributor")))];
  }

  private cliOutput(args: string[], subject: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFileCompat(this.bin, args, {
        cwd: this.cwd, env: this.env, timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true,
      }, (error, stdout) => {
        if (error) reject(new Error(`Muse ${subject} is unavailable.`));
        else resolve(stdout);
      });
    });
  }

  async subscription(): Promise<MuseSubscription> {
    const account = await this.request("account/read");
    if (account.state === "apiKey" || account.state === "envKey") return { status: "api_key" };
    if (account.state === "loggedOut") return { status: "signed_out" };
    if (account.credentialRequired !== true || account.state !== "accountLogin") return { status: "unknown" };
    const allowance = await this.request("usage/refresh");
    if (allowance.subscriptionActive === false) return { status: "no_subscription" };
    if (allowance.subscriptionActive !== true) return { status: "unknown" };
    return {
      status: "subscription",
      tier: typeof allowance.tierName === "string" ? allowance.tierName.slice(0, 100) : undefined,
      ...parseAllowance(allowance.usage),
    };
  }

  async request(method: string, params?: object): Promise<Record<string, unknown>> {
    if (this.stopped) throw this.stopped;
    const timer = setTimeout(() => this.stop(`Muse ${method} timed out`), REQUEST_TIMEOUT_MS);
    try {
      const result = await this.rpc.request(method, params);
      if (!isPlainObject(result)) throw new Error("invalid result");
      return result;
    } catch {
      throw this.stopped ?? new Error(`Muse rejected ${method}`);
    } finally {
      clearTimeout(timer);
    }
  }

  onNotification(listener: (method: string, params: Record<string, unknown>) => void): void {
    this.rpc.onNotification((method, params) => {
      if (!this.stopped) listener(method, museRecord(params));
    });
  }

  onServerRequest(listener: (method: string, params: Record<string, unknown>) => unknown): void {
    this.rpc.onServerRequest((method, params) => {
      this.assertActive();
      return listener(method, museRecord(params));
    });
  }

  onStop(listener: (error: Error) => void): void {
    if (this.stopped) listener(this.stopped);
    else this.stopListeners.add(listener);
  }

  assertActive(): void {
    if (this.stopped) throw this.stopped;
  }

  get alive(): boolean {
    return !this.exited && !this.stopped;
  }

  stop(reason: string): void {
    if (this.stopped) return;
    this.stopped = new Error(reason);
    this.rpc.rejectAll(this.stopped);
    for (const listener of this.stopListeners) listener(this.stopped);
    this.stopListeners.clear();
  }

  async close(graceful: boolean): Promise<void> {
    if (graceful) this.proc.stdin.end();
    else killChildTree(this.proc);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.closed,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => { killChildTree(this.proc, "SIGKILL"); resolve(); }, SHUTDOWN_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
