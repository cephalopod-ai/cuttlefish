// packages/cuttlefish/src/engines/vibe-acp.ts
import { type ChildProcess } from "node:child_process";
import { killProcessTree, spawnCompat } from "../shared/windows-exec.js";
import type { InterruptibleEngine, EngineRunOpts, EngineResult } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { HermesRpc } from "./hermes-jsonrpc.js";
import { mapSessionUpdate, extractPromptText } from "./vibe-protocol.js";
import { buildEngineEnv } from "../shared/engine-env.js";
import { capAppend, ENGINE_OUTPUT_MAX } from "../shared/cap-append.js";

const TURN_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
const HANDSHAKE_TIMEOUT_MS = 60_000;
const ALLOW_ALWAYS = { outcome: { outcome: "selected", optionId: "allow_always" } };

interface ProcHandle {
  rpc: HermesRpc;
  killProc: () => void;
  isAliveProc: () => boolean;
  onExit: (cb: () => void) => void;
  onError: (cb: (err: Error) => void) => void;
}

interface VibeProc {
  handle: ProcHandle;
  alive: boolean;
  vibeSessionId?: string;
  currentModelId?: string;
  initialized: Promise<void>;
}

/**
 * Vibe (Mistral AI's CLI) ships a dedicated ACP-over-stdio entrypoint —
 * `vibe-acp` — so this speaks real Agent Client Protocol, same shape as
 * hermes-acp.ts (which this closely mirrors, including its shared
 * HermesRpc transport and permission auto-approve behavior).
 */
export class VibeAcpEngine implements InterruptibleEngine {
  name = "vibe" as const;
  private procs = new Map<string, VibeProc>();
  /** Guards against two concurrent turns racing on the same session's single
   *  shared HermesRpc notify callback (mirrors the `active` guard used by the
   *  claude/codex/grok/antigravity/hermes interactive engines). */
  private active = new Set<string>();
  /** Overridable in tests to shorten the handshake timeout. */
  protected handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS;

  /** Test seam — overridden in unit tests to inject a fake server. */
  protected spawnProc(bin: string, cwd: string): ProcHandle {
    const child: ChildProcess = spawnCompat(bin, [], {
      stdio: ["pipe", "pipe", "ignore"],
      cwd,
      detached: process.platform !== "win32",
      env: buildEngineEnv(),
    });
    const rpc = new HermesRpc(child.stdin!, child.stdout!);
    return {
      rpc,
      killProc: () => {
        try { killProcessTree(child.pid!, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* ignore */ } }
        const force = setTimeout(() => {
          if (child.exitCode !== null) return;
          try { killProcessTree(child.pid!, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* ignore */ } }
        }, 2_000);
        force.unref?.();
      },
      isAliveProc: () => child.exitCode === null && !child.killed,
      onExit: (cb) => child.on("exit", cb),
      onError: (cb) => child.on("error", cb),
    };
  }

  private getOrSpawn(cuttlefishId: string, bin: string, cwd: string): VibeProc {
    const existing = this.procs.get(cuttlefishId);
    if (existing && existing.alive) return existing;

    const handle = this.spawnProc(bin, cwd);
    handle.rpc.onServerRequest((method) =>
      method === "session/request_permission" ? ALLOW_ALWAYS : {},
    );
    const entry: VibeProc = {
      handle,
      alive: true,
      initialized: handle.rpc.request("initialize", { protocolVersion: 1, clientCapabilities: {} }).then(() => {}),
    };
    handle.onExit(() => {
      entry.alive = false;
      handle.rpc.rejectAll(new Error("vibe acp exited"));
    });
    handle.onError((err) => {
      entry.alive = false;
      handle.rpc.rejectAll(new Error("vibe acp spawn/process error: " + err.message));
    });
    this.procs.set(cuttlefishId, entry);
    return entry;
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const cuttlefishId = opts.sessionId || opts.resumeSessionId || "default";
    if (this.active.has(cuttlefishId)) {
      return { sessionId: opts.resumeSessionId ?? "", result: "", error: "Vibe engine: a turn is already running for this session" };
    }
    this.active.add(cuttlefishId);
    const bin = resolveBin("vibe-acp", opts.bin);
    const p = this.getOrSpawn(cuttlefishId, bin, opts.cwd);
    const { rpc } = p.handle;

    let handshakeWatchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await p.initialized;

          if (!p.vibeSessionId) {
            if (opts.resumeSessionId) {
              try {
                await rpc.request("session/load", { sessionId: opts.resumeSessionId, cwd: opts.cwd, mcpServers: [] });
                p.vibeSessionId = opts.resumeSessionId;
              } catch (loadErr) {
                logger.warn(
                  `[vibe-acp] session/load failed for ${opts.resumeSessionId}, falling back to session/new: ` +
                  (loadErr instanceof Error ? loadErr.message : String(loadErr)),
                );
                const ns = await rpc.request<Record<string, unknown>>("session/new", { cwd: opts.cwd, mcpServers: [] });
                p.vibeSessionId = String(ns.sessionId);
                const models = ns.models as Record<string, unknown> | undefined;
                p.currentModelId = models?.currentModelId ? String(models.currentModelId) : undefined;
              }
            } else {
              const ns = await rpc.request<Record<string, unknown>>("session/new", { cwd: opts.cwd, mcpServers: [] });
              p.vibeSessionId = String(ns.sessionId);
              const models = ns.models as Record<string, unknown> | undefined;
              p.currentModelId = models?.currentModelId ? String(models.currentModelId) : undefined;
            }
            // Vibe's own mode vocabulary (ask/plan/accept-edits/auto-approve) differs
            // from Hermes's dont_ask; auto-approve matches Cuttlefish's own
            // allow_always permission handling in getOrSpawn above.
            await rpc.request("session/set_mode", { sessionId: p.vibeSessionId, modeId: "auto-approve" }).catch(() => {});
          }

          if (opts.model && opts.model !== p.currentModelId) {
            await rpc.request("session/set_model", { sessionId: p.vibeSessionId, modelId: opts.model }).catch(() => {});
            p.currentModelId = opts.model;
          }
        })(),
        new Promise<never>((_, rej) => {
          handshakeWatchdog = setTimeout(
            () => rej(new Error("vibe acp handshake timeout")),
            this.handshakeTimeoutMs,
          );
          handshakeWatchdog.unref?.();
        }),
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[vibe-acp] handshake error for ${cuttlefishId}: ${msg}`);
      p.alive = false;
      try { p.handle.killProc(); } catch { /* ignore */ }
      if (this.procs.get(cuttlefishId) === p) this.procs.delete(cuttlefishId);
      this.active.delete(cuttlefishId);
      return { sessionId: "", result: "", error: msg };
    } finally {
      if (handshakeWatchdog) clearTimeout(handshakeWatchdog);
    }

    const rawPrompt =
      opts.systemPrompt && !opts.resumeSessionId
        ? `${opts.systemPrompt}\n\n${opts.prompt}`
        : opts.prompt;

    let resultText = "";
    let lastContext: number | undefined;
    const vibeSessionId = p.vibeSessionId;

    const onNote = (m: string, params: Record<string, unknown>) => {
      if (m !== "session/update" || params.sessionId !== vibeSessionId) return;
      const u = mapSessionUpdate((params.update ?? {}) as Record<string, unknown>);
      for (const d of u.deltas) {
        if (d.type === "text") resultText = capAppend(resultText, d.content, ENGINE_OUTPUT_MAX);
        opts.onStream?.(d);
      }
      if (u.contextTokens != null) lastContext = u.contextTokens;
    };
    rpc.onNotification(onNote);

    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        rpc.request<Record<string, unknown>>("session/prompt", {
          sessionId: vibeSessionId,
          prompt: extractPromptText(rawPrompt),
        }),
        new Promise<never>((_, rej) => {
          watchdog = setTimeout(() => rej(new Error("vibe turn timeout")), TURN_TIMEOUT_MS);
          watchdog.unref?.();
        }),
      ]);

      const stop = String(res.stopReason ?? res.stop_reason ?? "");
      const error =
        !resultText && (stop === "refusal" || stop === "cancelled")
          ? `Vibe turn ended: ${stop}`
          : undefined;

      this.active.delete(cuttlefishId);
      return {
        sessionId: vibeSessionId!,
        result: resultText,
        contextTokens: lastContext,
        error,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[vibe-acp] turn error for ${cuttlefishId}: ${msg}`);
      this.active.delete(cuttlefishId);
      return {
        sessionId: vibeSessionId || "",
        result: resultText,
        contextTokens: lastContext,
        error: resultText ? undefined : msg,
      };
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
  }

  kill(sessionId: string): void {
    const p = this.procs.get(sessionId);
    if (!p) return;
    p.alive = false;
    try { p.handle.killProc(); } catch { /* ignore */ }
    this.procs.delete(sessionId);
  }

  isAlive(sessionId: string): boolean {
    const p = this.procs.get(sessionId);
    return !!p && p.alive && p.handle.isAliveProc();
  }

  killAll(): void {
    for (const p of this.procs.values()) {
      p.alive = false;
      try { p.handle.killProc(); } catch { /* ignore */ }
    }
    this.procs.clear();
  }

  /** No shared idle pool — per-session procs recycle via kill on org reload. */
  killIdle(): void {
    /* no-op */
  }
}
