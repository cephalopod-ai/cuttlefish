/**
 * Shared rate-limit / fallback / wait-and-retry handler.
 *
 * Both the connector path (sessions/manager.ts → runSession) and the web path
 * (gateway/api.ts → runWebSession) need to:
 *   1. Detect a usage-limit response.
 *   2. Optionally fall back to a different engine (default: Codex) while the active
 *      engine resets.
 *   3. Otherwise enter a "waiting" loop: sleep until the reset window, retry on the
 *      active engine, keep the session's lastActivity heartbeat fresh, and loop again
 *      if still limited.
 *   4. Bail out when the deadline passes without recovery.
 *
 * The state machine, engine invocations, retry math, heartbeat cadence, deadline
 * computation, and `transportMeta.engineOverride` bookkeeping are identical between
 * the two call sites — only the transport-side UI/notification details differ.
 * This module owns the common bits; per-transport behavior is injected via hooks.
 *
 * Behavior is intentionally preserved verbatim from the original inlined
 * implementations — do not "improve" the wait math, the per-step state writes,
 * or the order of side effects without auditing both call sites.
 */

import type { Employee, Engine, EngineResult, CuttlefishConfig, JsonObject, Session, StreamDelta } from "../shared/types.js";
import { CUTTLEFISH_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { resolveEffort } from "../shared/effort.js";
import { effortLevelsForModel, engineAvailable, isKnownEngine } from "../shared/models.js";
import { computeNextRetryDelayMs, computeRateLimitDeadlineMs, detectRateLimit } from "../shared/rateLimit.js";
import { recordEngineRateLimit } from "../shared/usage-status.js";
import { getSession, getMessages, updateSession, patchSessionTransportMeta } from "./registry.js";

const WAIT_CANCEL_POLL_MS = 5000;
const ENGINE_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  grok: "Grok",
  pi: "Pi",
  kiro: "Kiro",
  ollama: "Ollama",
  kilo: "Kilo",
};

export function engineLabel(engine: string): string {
  return ENGINE_LABELS[engine] ?? (engine ? engine.charAt(0).toUpperCase() + engine.slice(1) : "Engine");
}

export function rateLimitSummary(engine: string): string {
  return `${engineLabel(engine)} usage limit`;
}

export function rateLimitFallbackNotice(engine: string, fallbackEngine: string, resumeText: string | null): string {
  return `⚠️ ${rateLimitSummary(engine)} reached${resumeText ? `. Resets ${resumeText}` : ""}. Switching to ${engineLabel(fallbackEngine)} for now.`;
}

export function rateLimitWaitingNotice(engine: string, resumeText: string | null): string {
  return `⏳ ${rateLimitSummary(engine)} reached${resumeText ? `. Resets ${resumeText}` : ""} — I'll continue automatically.`;
}

export function rateLimitPausedNotice(engine: string, resumeText: string | null): string {
  return `⏳ Still paused due to ${rateLimitSummary(engine).toLowerCase()}${resumeText ? ` (resets ${resumeText})` : ""}. I queued this message and will respond automatically.`;
}

export function rateLimitTimeoutError(engine: string): string {
  return `${rateLimitSummary(engine)} did not clear in time`;
}

/** What detectRateLimit returned for the original turn. */
export interface RateLimitInfo {
  /** Unix timestamp (seconds) when the limit is expected to reset, if known. */
  resetsAt?: number;
}

/** Outcome categories returned by handleRateLimit so callers can drive transport-side completion. */
export type RateLimitOutcome =
  | { kind: "fallback"; result: EngineResult }
  | { kind: "resumed"; result: EngineResult }
  | { kind: "timeout" }
  | { kind: "cancelled" };

export interface RateLimitHandlerHooks {
  /**
   * Called once, immediately after detection, before any state changes. The
   * default usage-awareness recorder records the active engine.
   * Override only if you need additional bookkeeping.
   */
  onDetected?: (rateLimit: RateLimitInfo) => void;

  /**
   * Called when entering the fallback branch (before the fallback engine runs).
   * Use this to: notify the user we're switching engines (UI message, connector alert, etc.).
   */
  onFallbackStart?: (info: { resumeAt: Date | null; until: Date; originalEngine: string; fallbackName: string }) => void | Promise<void>;

  /**
   * Optional stream callback for the fallback engine's run (web emits deltas here).
   */
  onFallbackStream?: (delta: StreamDelta) => void;

  /**
   * Called after the fallback engine finishes, before the handler returns.
   * The persistence of the assistant message and any "completed" event emission
   * is done here (caller-specific).
   */
  onFallbackComplete?: (result: EngineResult) => void | Promise<void>;

  /**
   * Called once when entering the wait-and-retry loop. Use this to: switch UI
   * to "waiting", post a "I'll continue automatically" message, notify the configured connector, etc.
   */
  onWaitingStart?: (info: { resumeAt: Date | null; rateLimit: RateLimitInfo }) => void | Promise<void>;

  /**
   * Called each retry iteration BEFORE the retry engine.run — switch UI back
   * to "thinking" state.
   */
  onRetryAttempt?: (info: { attempt: number }) => void | Promise<void>;

  /**
   * Called each iteration when the retry was STILL rate-limited — switch UI
   * back to "waiting" state, log, etc.
   */
  onStillLimited?: (info: { attempt: number; resumeAt: Date | null }) => void | Promise<void>;

  /**
   * Optional stream callback for the retry engine's run (web emits deltas).
   */
  onRetryStream?: (delta: StreamDelta) => void;

  /**
   * Called when a retry succeeds (or fails with a non-rate-limit error).
   * Persist the assistant message + emit completion event here.
   */
  onRetrySuccess?: (result: EngineResult) => void | Promise<void>;

  /**
   * Called when the deadline expires before the limit clears. Notify the user,
   * mark session errored, emit completion event with the timeout error.
   */
  onTimeout?: () => void | Promise<void>;

  /**
   * Called when the session was deleted/cancelled while waiting. The handler
   * has already returned — this is just a hook to log or emit cleanup.
   */
  onCancelled?: () => void | Promise<void>;
}

export interface RateLimitHandlerOpts {
  session: Session;
  /** The original prompt that hit the rate limit — used unchanged for retries. */
  prompt: string;
  systemPrompt?: string;
  /** Engine config used by the original turn (bin + model + …). */
  engineConfig: { bin?: string; model?: string };
  effortLevel?: string;
  /** Optional employee-level CLI flag overrides (passed to retry engine.run calls). */
  cliFlags?: string[];
  /** Path to MCP config JSON file, if applicable to the original turn. */
  mcpConfigPath?: string;
  /** Optional attachment file paths from the original turn (preserved on retry). */
  attachments?: string[];
  /** The current cuttlefish config (used to look up rateLimitStrategy + fallbackEngine + fallback engineConfig). */
  config: CuttlefishConfig;
  /** Map of available engines (for fallback lookup). */
  engines: Map<string, Engine>;
  /** Optional employee record (for fallback effort + cliFlags). */
  employee?: Employee;
  /** The engine used for retries — the engine that returned the rate-limited result. */
  engine: Engine;
  /** Result of detectRateLimit() on the original turn. */
  rateLimit: RateLimitInfo;
  /** The original failed result — used for its sessionId field when updating engineSessionId. */
  originalResult: EngineResult;
  hooks: RateLimitHandlerHooks;
}

/**
 * Drive the rate-limit recovery state machine. Returns once the situation
 * resolves (success, fallback completion, timeout, or cancellation).
 *
 * The caller has ALREADY detected the rate limit and confirmed it should be
 * handled (i.e. not a dead session, not an interrupted turn).
 */
export async function handleRateLimit(opts: RateLimitHandlerOpts): Promise<RateLimitOutcome> {
  const {
    session, prompt, systemPrompt, engineConfig, effortLevel, cliFlags,
    mcpConfigPath, attachments, config, engines, employee, engine,
    rateLimit, originalResult, hooks,
  } = opts;
  const sourceEngine = session.engine;

  if (hooks.onDetected) hooks.onDetected(rateLimit);
  else recordEngineRateLimit(sourceEngine, rateLimit.resetsAt);

  const strategy = config.sessions?.rateLimitStrategy ?? "wait";

  // ── Branch A: fallback to another configured engine ───────────────────────
  if (strategy === "fallback") {
    const fallbackName = config.sessions?.fallbackEngine ?? "codex";
    if (isKnownEngine(fallbackName) && fallbackName !== sourceEngine) {
      const fallbackEngine = engines.get(fallbackName);
      const fallbackConfig = (config.engines as unknown as Record<string, { bin?: string; model?: string; effortLevel?: string } | undefined>)[fallbackName];
      if (fallbackEngine && fallbackConfig && engineAvailable(config, fallbackName)) {
        const { resumeAt } = computeNextRetryDelayMs(rateLimit.resetsAt);
        const until = resumeAt ?? new Date(Date.now() + 6 * 60 * 60_000);
        const syncSince = new Date().toISOString();

        await hooks.onFallbackStart?.({ resumeAt: resumeAt ?? null, until, originalEngine: sourceEngine, fallbackName });

        const nextMeta = { ...(session.transportMeta || {}) } as Record<string, unknown>;
        const engineSessionsRaw = nextMeta.engineSessions;
        const engineSessions = (engineSessionsRaw && typeof engineSessionsRaw === "object" && !Array.isArray(engineSessionsRaw))
          ? { ...(engineSessionsRaw as Record<string, unknown>) }
          : {};
        if (session.engineSessionId) {
          engineSessions[sourceEngine] = session.engineSessionId;
        }
        nextMeta.engineSessions = engineSessions;
        nextMeta.engineOverride = {
          originalEngine: sourceEngine,
          originalEngineSessionId: session.engineSessionId,
          until: until.toISOString(),
          syncSince,
        };

        updateSession(session.id, {
          engine: fallbackName,
          // Keep the original engine_session_id intact for later restore; the fallback engine will return its own thread id.
          status: "running",
          lastActivity: new Date().toISOString(),
          lastError: resumeAt
            ? `${rateLimitSummary(sourceEngine)} — using ${engineLabel(fallbackName)} until ${resumeAt.toISOString()}`
            : `${rateLimitSummary(sourceEngine)} — using ${engineLabel(fallbackName)} temporarily`,
        });
        patchSessionTransportMeta(session.id, (current) => ({
          ...current,
          engineSessions: engineSessions as JsonObject,
          engineOverride: nextMeta.engineOverride as JsonObject,
        }));

        const fallbackEffort = resolveEffort(
          fallbackConfig,
          session,
          employee,
          effortLevelsForModel(config, fallbackName, fallbackConfig.model),
        );
        const fallbackResume = typeof engineSessions[fallbackName] === "string" ? (engineSessions[fallbackName] as string) : undefined;
        const history = getMessages(session.id)
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => `${m.role.toUpperCase()}: ${m.content}`);
        const historyText = history.slice(-12).join("\n\n");
        const fallbackPrompt = fallbackResume
          ? prompt
          : `Continue this conversation and respond to the last USER message.\n\nConversation so far:\n\n${historyText}`;

        let fallbackResult: EngineResult;
        try {
          fallbackResult = await fallbackEngine.run({
            prompt: fallbackPrompt,
            resumeSessionId: fallbackResume,
            systemPrompt,
            cwd: session.cwd || CUTTLEFISH_HOME,
            bin: fallbackConfig.bin,
            model: fallbackConfig.model,
            effortLevel: fallbackEffort,
            cliFlags: employee?.cliFlags ?? cliFlags,
            attachments: attachments?.length ? attachments : undefined,
            sessionId: session.id,
            ...(hooks.onFallbackStream ? { onStream: hooks.onFallbackStream } : {}),
          });
        } catch (err) {
          // The engineOverride + engine switch were persisted BEFORE this run. If
          // the fallback engine throws, leaving them in place would strand the
          // session on the fallback engine until the (up to 6h) `until` window
          // expired — every subsequent turn routed to the wrong engine. Revert the
          // override immediately so the next turn retries on the original engine,
          // then rethrow for the caller's normal error handling.
          updateSession(session.id, { engine: sourceEngine, engineSessionId: session.engineSessionId });
          patchSessionTransportMeta(session.id, (current) => {
            const next = { ...current };
            delete (next as Record<string, unknown>).engineOverride;
            return next;
          });
          logger.warn(`Session ${session.id}: fallback engine "${fallbackName}" failed; reverted to "${sourceEngine}". ${err instanceof Error ? err.message : String(err)}`);
          throw err;
        }

        // Persist the fallback engine thread id so future fallbacks can resume it.
        const nextEngineSessions = { ...engineSessions };
        if (fallbackResult.sessionId) {
          nextEngineSessions[fallbackName] = fallbackResult.sessionId;
        }
        patchSessionTransportMeta(session.id, { engineSessions: nextEngineSessions as any });

        await hooks.onFallbackComplete?.(fallbackResult);

        return { kind: "fallback", result: fallbackResult };
      }
    }
    // No fallback engine available — fall through to wait-and-retry.
  }

  // ── Branch B: wait-and-retry on the active engine ──────────────────────────
  const { delayMs, resumeAt } = computeNextRetryDelayMs(rateLimit.resetsAt);
  const deadlineMs = computeRateLimitDeadlineMs(
    rateLimit.resetsAt,
    rateLimit.resetsAt ? 30 * 60_000 : 6 * 60 * 60_000,
  );

  logger.info(
    `Session ${session.id} hit ${rateLimitSummary(sourceEngine).toLowerCase()} — will auto-retry ${resumeAt ? `at ${resumeAt.toISOString()}` : `in ${Math.round(delayMs / 1000)}s`}`,
  );

  updateSession(session.id, {
    ...(originalResult.sessionId?.trim() ? { engineSessionId: originalResult.sessionId } : {}),
    status: "waiting",
    lastActivity: new Date().toISOString(),
    lastError: resumeAt
      ? `${rateLimitSummary(sourceEngine)} — resumes ${resumeAt.toISOString()}`
      : `${rateLimitSummary(sourceEngine)} — waiting for reset`,
  });

  await hooks.onWaitingStart?.({ resumeAt: resumeAt ?? null, rateLimit });

  // Keep lastActivity fresh while waiting (UI / status endpoints).
  const heartbeat = setInterval(() => {
    if (getSession(session.id)?.status === "waiting") {
      updateSession(session.id, { status: "waiting", lastActivity: new Date().toISOString() });
    }
  }, 60_000);

  try {
    let attempt = 0;
    let nextDelayMs = delayMs;

    while (Date.now() < deadlineMs) {
      const stillWaiting = await waitWhileSessionWaiting(session.id, nextDelayMs);
      if (!stillWaiting) {
        const currentSession = getSession(session.id);
        logger.info(`Session ${session.id} stopped while waiting for usage reset (status=${currentSession?.status ?? "deleted"})`);
        await hooks.onCancelled?.();
        return { kind: "cancelled" };
      }
      attempt++;

      // Check if session was stopped while waiting. We set status:"waiting"
      // before entering this loop, so any other status (idle from a user
      // POST /stop, error from a crash, etc.) means the user/system pulled
      // us out of the waiting state and we should NOT retry. Previously this
      // only caught "error", so user-initiated stop ("idle") leaked through
      // and the retry fired against a session the user thought was stopped.
      const currentSession = getSession(session.id);
      if (!currentSession || currentSession.status !== "waiting") {
        logger.info(`Session ${session.id} stopped while waiting for usage reset (status=${currentSession?.status ?? "deleted"})`);
        await hooks.onCancelled?.();
        return { kind: "cancelled" };
      }

      await hooks.onRetryAttempt?.({ attempt });
      logger.info(`Session ${session.id} retrying after usage limit (attempt ${attempt})`);

      const retryResult = await engine.run({
        prompt,
        resumeSessionId: currentSession.engineSessionId ?? undefined,
        systemPrompt,
        cwd: currentSession.cwd || CUTTLEFISH_HOME,
        bin: engineConfig.bin,
        model: currentSession.model ?? engineConfig.model,
        effortLevel,
        cliFlags,
        mcpConfigPath,
        attachments: attachments?.length ? attachments : undefined,
        sessionId: session.id,
        source: session.source,
        ...(hooks.onRetryStream ? { onStream: hooks.onRetryStream } : {}),
      });

      const retryInterrupted = retryResult.error?.startsWith("Interrupted");
      const retryRateLimit = !retryInterrupted ? detectRateLimit(retryResult) : { limited: false as const };

      if (retryRateLimit.limited) {
        recordEngineRateLimit(sourceEngine, retryRateLimit.resetsAt);
        logger.info(`Session ${session.id} still rate limited (attempt ${attempt})`);

        const next = computeNextRetryDelayMs(retryRateLimit.resetsAt);
        nextDelayMs = next.delayMs;

        updateSession(session.id, {
          ...(retryResult.sessionId?.trim() ? { engineSessionId: retryResult.sessionId } : {}),
          status: "waiting",
          lastActivity: new Date().toISOString(),
          lastError: next.resumeAt
            ? `${rateLimitSummary(sourceEngine)} — resumes ${next.resumeAt.toISOString()}`
            : `${rateLimitSummary(sourceEngine)} — waiting for reset`,
        });

        await hooks.onStillLimited?.({ attempt, resumeAt: next.resumeAt ?? null });
        continue;
      }

      // Success (or non-rate-limit error) — hand off to caller for persistence + transport.
      await hooks.onRetrySuccess?.(retryResult);
      logger.info(`Session ${session.id} resumed after usage reset`);
      return { kind: "resumed", result: retryResult };
    }

    // Deadline exhausted without recovery.
    await hooks.onTimeout?.();
    logger.warn(`Session ${session.id} exhausted usage limit retries`);
    return { kind: "timeout" };
  } finally {
    clearInterval(heartbeat);
  }
}

async function waitWhileSessionWaiting(sessionId: string, delayMs: number): Promise<boolean> {
  const end = Date.now() + Math.max(0, delayMs);
  while (Date.now() < end) {
    const currentSession = getSession(sessionId);
    if (!currentSession || currentSession.status !== "waiting") return false;
    const sleepMs = Math.min(WAIT_CANCEL_POLL_MS, end - Date.now());
    if (sleepMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
  }
  const currentSession = getSession(sessionId);
  return !!currentSession && currentSession.status === "waiting";
}
