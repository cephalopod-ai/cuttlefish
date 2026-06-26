import type { EngineResult } from "../shared/types.js";
import type { HookPayload } from "../gateway/hook-registry.js";
import { stripReasoningBlocks } from "./claude-interactive-transcript.js";

const STOP_FAILURE_GRACE_MS = 20_000;
/** StopFailure errors that must settle immediately. Rate-limit/billing/auth
 *  need the manager fallback machinery right away; everything else gets a grace
 *  window because Claude Code can keep working after a sub-agent/API failure. */
const IMMEDIATE_STOP_FAILURE_ERRORS = new Set(["rate_limit", "billing_error", "authentication_failed", "max_output_tokens"]);

export interface TurnResolverOpts {
  fallbackSessionId: string | undefined;
  /** When true (warm-PTY reuse / post-idle-spawn), the resolver skips waiting for
   *  SessionStart (it already fired once at process start) and pre-fills the
   *  Claude session id from fallbackSessionId. */
  assumeStarted?: boolean;
  /** Test override for the StopFailure grace window (default 20s). */
  stopFailureGraceMs?: number;
  /** While true, a graced StopFailure keeps waiting instead of settling. */
  shouldDeferStopFailure?: () => boolean;
  /** This turn is a Claude-native local command (see isNativeClaudeCommand). Such
   *  commands produce no new assistant message, so a Stop hook's
   *  last_assistant_message is the PREVIOUS turn's stale text — maybeComplete must
   *  settle empty rather than re-persist it as a duplicate. */
  native?: boolean;
}

/** State machine for one interactive turn: resolves after BOTH SessionStart + Stop, or on StopFailure/interrupt. */
export class TurnResolver {
  readonly promise: Promise<EngineResult>;
  private resolve!: (r: EngineResult) => void;
  private settled = false;
  private claudeSessionId: string | undefined;
  private gotSessionStart = false;
  private stopPayload: HookPayload | undefined;
  private stopFailurePayload: HookPayload | undefined;
  private graceTimer: NodeJS.Timeout | undefined;

  constructor(private opts: TurnResolverOpts) {
    this.promise = new Promise((res) => { this.resolve = res; });
    if (opts.assumeStarted) {
      this.gotSessionStart = true;
      this.claudeSessionId = opts.fallbackSessionId;
    }
  }

  onHook(h: HookPayload): void {
    if (this.settled) return;
    if (h.hook_event_name === "SessionStart") {
      this.gotSessionStart = true;
      if (typeof h.session_id === "string") this.claudeSessionId = h.session_id;
      this.maybeComplete();
    } else if (h.hook_event_name === "Stop") {
      // A Stop supersedes any pending StopFailure — the CLI retried and finished.
      this.clearGrace();
      this.stopFailurePayload = undefined;
      this.stopPayload = h;
      if (typeof h.session_id === "string" && !this.claudeSessionId) this.claudeSessionId = h.session_id;
      this.maybeComplete();
    } else if (h.hook_event_name === "StopFailure") {
      // API error ended the turn. In interactive mode the CLI survives
      // invalid_request/server_error/unknown and usually retries — hold the
      // failure in a grace window instead of settling: a later Stop supersedes
      // it, activity re-arms it, the PTY-death watchdog still fails fast.
      // Other error types (rate_limit, billing, auth) settle immediately.
      // numTurns:1 keeps isDeadSessionError from false-positiving.
      this.stopFailurePayload = h;
      if (typeof h.session_id === "string" && !this.claudeSessionId) this.claudeSessionId = h.session_id;
      if (!IMMEDIATE_STOP_FAILURE_ERRORS.has(String(h.error ?? "unknown"))) {
        this.armGrace();
      } else {
        this.settleWithFailure();
      }
    } else {
      // PreToolUse/PostToolUse/etc — proof of life while a failure is pending.
      this.noteActivity();
    }
  }

  /** Claude session id learned so far (for engineSessionId persistence on warm-PTY turns). */
  get sessionId(): string | undefined { return this.claudeSessionId; }
  get isSettled(): boolean { return this.settled; }
  /** The StopFailure payload, if the turn ended in an API error (Task 5.3 maps it to rateLimit). */
  get stopFailure(): HookPayload | undefined { return this.stopFailurePayload; }
  /** transcript_path from whichever hook carried it. */
  get transcriptPath(): string | undefined {
    const p = this.stopPayload?.transcript_path ?? this.stopFailurePayload?.transcript_path;
    return typeof p === "string" ? p : undefined;
  }

  private maybeComplete(): void {
    if (!this.gotSessionStart || !this.stopPayload) return;
    const sid = this.claudeSessionId ?? this.opts.fallbackSessionId;
    if (!sid) {
      this.settle({ sessionId: "", result: "", error: "Interactive turn produced no Claude session id" });
      return;
    }
    // Native local commands (/usage, /limits, …) produce no new assistant
    // message; the Stop hook's last_assistant_message is the prior turn's stale
    // text. Settling with it would persist a duplicate chat echo — settle empty.
    const text = this.opts.native ? "" : stripReasoningBlocks(String(this.stopPayload.last_assistant_message ?? ""));
    this.settle({ sessionId: sid, result: text, error: undefined, numTurns: 1 });
  }

  interrupt(reason: string): void {
    // PTY died while a StopFailure was held in grace — the API error is the
    // real cause; report it instead of the generic "process exited". Other
    // interrupt reasons (user abort, engine switch, preemption) keep their
    // "Interrupted: …" text so the quiet-interrupt handling downstream engages.
    if (this.stopFailurePayload && !this.settled && reason === "Interrupted: claude process exited") {
      this.settleWithFailure();
      return;
    }
    this.settle({ sessionId: this.claudeSessionId ?? this.opts.fallbackSessionId ?? "", result: "", error: reason });
  }

  completeNativeCommand(): void {
    this.settle({ sessionId: this.claudeSessionId ?? this.opts.fallbackSessionId ?? "", result: "", numTurns: 1 });
  }

  completeRecovered(text: string, sessionId?: string): void {
    if (sessionId && !this.claudeSessionId) this.claudeSessionId = sessionId;
    this.settle({ sessionId: this.claudeSessionId ?? this.opts.fallbackSessionId ?? "", result: stripReasoningBlocks(text), numTurns: 1 });
  }

  /** Proof of life (SSE delta / tool hook) while a StopFailure is pending —
   *  re-arms the grace window. No-op when no failure is pending. */
  noteActivity(): void {
    if (this.graceTimer) this.armGrace();
  }

  private armGrace(): void {
    this.clearGrace();
    const ms = this.opts.stopFailureGraceMs ?? STOP_FAILURE_GRACE_MS;
    this.graceTimer = setTimeout(() => {
      if (this.opts.shouldDeferStopFailure?.()) {
        this.armGrace();
        return;
      }
      this.settleWithFailure();
    }, ms);
    this.graceTimer.unref?.();
  }

  private clearGrace(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
  }

  private settleWithFailure(): void {
    this.settle({
      sessionId: this.claudeSessionId ?? this.opts.fallbackSessionId ?? "",
      result: "",
      error: `Interactive turn failed: ${this.stopFailurePayload?.error ?? "unknown"}`,
      numTurns: 1,
    });
  }

  private settle(r: EngineResult): void {
    if (this.settled) return;
    this.settled = true;
    this.clearGrace();
    this.resolve(r);
  }
}
