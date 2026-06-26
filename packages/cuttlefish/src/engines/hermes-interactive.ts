import * as pty from "node-pty";
import type { InterruptibleEngine, EngineRunOpts, EngineResult } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { CUTTLEFISH_HOME } from "../shared/paths.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { PtyLifecycleManager } from "./pty-lifecycle.js";
import { PtyStreamManager, createPtyHandle, setCapped } from "./pty-stream.js";
import type { PtyControlEvent, PtyIdleSpawnOpts, PtyViewEngine } from "./pty-view-engine.js";

// ── Pure helpers (exported for testing) ──────────────────────────────────────

export function buildHermesInteractiveArgs(): string[] {
  return ["chat", "--cli", "--yolo", "--accept-hooks"];
}

export function isHermesTuiReady(output: string): boolean {
  return /hermes\s*[›>❯]/i.test(output);
}

// ── Engine ────────────────────────────────────────────────────────────────────

export class HermesInteractiveEngine implements InterruptibleEngine, PtyViewEngine {
  name = "hermes" as const;
  private streams: PtyStreamManager;
  private lastGeom = new Map<string, { cols: number; rows: number }>();

  constructor(private lifecycle: PtyLifecycleManager) {
    this.streams = new PtyStreamManager("Hermes PTY", (id) => this.lifecycle.getWarm(id) !== undefined);
  }

  /**
   * v1 — CLI Mode is VIEW-ONLY.
   * Work turns run through HermesAcpEngine (registered separately).
   */
  async run(_opts: EngineRunOpts): Promise<EngineResult> {
    return {
      sessionId: "",
      result: "",
      error: "Hermes CLI Mode is view-only; work turns run on Hermes Chat Mode (ACP).",
    };
  }

  // ── PtyViewEngine ─────────────────────────────────────────────────────────

  ensureIdleSpawn(cuttlefishSessionId: string, opts: PtyIdleSpawnOpts): void {
    if (opts.cols && opts.rows) setCapped(this.lastGeom, cuttlefishSessionId, { cols: opts.cols, rows: opts.rows });
    if (this.lifecycle.getWarm(cuttlefishSessionId)) return;
    const handle = this.spawn(cuttlefishSessionId, opts);
    this.lifecycle.adopt(cuttlefishSessionId, handle);
  }

  hasWarmPty(sessionId: string): boolean {
    return this.lifecycle.getWarm(sessionId) !== undefined;
  }

  getScrollback(sessionId: string): Buffer {
    return this.streams.getScrollback(sessionId);
  }

  subscribeOutput(
    sessionId: string,
    cb: (data: Buffer) => void,
    onControl?: (event: PtyControlEvent) => void,
  ): () => void {
    return this.streams.subscribe(sessionId, cb, onControl);
  }

  setViewing(sessionId: string, viewing: boolean): void {
    if (viewing) this.lifecycle.viewerEnter(sessionId);
    else this.lifecycle.viewerLeave(sessionId);
  }

  writeStdin(sessionId: string, text: string): void {
    const proc = (this.lifecycle.getWarm(sessionId) as any)?._proc as pty.IPty | undefined;
    if (proc) proc.write(`${text}\r`);
  }

  writeRaw(sessionId: string, data: string): void {
    const proc = (this.lifecycle.getWarm(sessionId) as any)?._proc as pty.IPty | undefined;
    if (proc) proc.write(data);
  }

  resizePty(sessionId: string, cols: number, rows: number): void {
    setCapped(this.lastGeom, sessionId, { cols, rows });
    const proc = (this.lifecycle.getWarm(sessionId) as any)?._proc as pty.IPty | undefined;
    try { proc?.resize(cols, rows); } catch { /* gone */ }
  }

  // ── InterruptibleEngine ────────────────────────────────────────────────────

  kill(sessionId: string, _reason = "Interrupted"): void {
    this.lifecycle.releaseSession(sessionId);
  }

  isAlive(sessionId: string): boolean {
    return this.lifecycle.getWarm(sessionId) !== undefined;
  }

  killAll(): void {
    this.lifecycle.killAll();
  }

  killIdle(): void {
    this.lifecycle.releaseIdle(() => false);
  }

  // ── Private spawn ─────────────────────────────────────────────────────────

  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    env.TERM = "xterm-256color";
    env.HERMES_YOLO_MODE = "1";
    env.HERMES_ACCEPT_HOOKS = "1";
    return env;
  }

  private spawn(cuttlefishSessionId: string, opts: PtyIdleSpawnOpts): ReturnType<typeof createPtyHandle> {
    const bin = resolveBin("hermes", opts.bin);
    const args = buildHermesInteractiveArgs();
    const geom = this.lastGeom.get(cuttlefishSessionId);
    logger.info(`HermesInteractiveEngine spawning ${bin} (geom: ${geom ? `${geom.cols}x${geom.rows}` : "default"})`);
    const proc = pty.spawn(bin, args, {
      name: "xterm-256color",
      cols: geom?.cols ?? 120,
      rows: geom?.rows ?? 40,
      cwd: opts.cwd || CUTTLEFISH_HOME,
      env: this.buildEnv(),
    });
    const handle = createPtyHandle(proc);
    this.streams.attach(cuttlefishSessionId, proc);
    proc.onExit(() => {
      const isCurrent = this.lifecycle.getWarm(cuttlefishSessionId) === handle;
      if (isCurrent) {
        this.streams.onPtyExit(cuttlefishSessionId);
        this.lifecycle.releaseSession(cuttlefishSessionId);
      }
    });
    return handle;
  }
}
