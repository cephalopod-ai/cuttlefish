import type { StreamDelta } from "./chat.js";

export interface Engine {
  name: string;
  run(opts: EngineRunOpts): Promise<EngineResult>;
}

export interface InterruptibleEngine extends Engine {
  kill(sessionId: string, reason?: string): void;
  isAlive(sessionId: string): boolean;
  killAll(): void;
  /** Recycle only IDLE warm PTYs (no in-flight turn), leaving active turns
   *  untouched. Used on org-reload so the next turn cold-respawns with the fresh
   *  persona without interrupting a turn that is currently running. Engines with
   *  no warm-PTY reuse (batch engines spawn fresh per turn) implement this as a
   *  no-op — there is nothing idle to recycle and live processes are active turns. */
  killIdle(): void;
}

export interface EngineHistoryMessage {
  role: string;
  content: string;
  timestamp?: number;
  partial?: boolean;
  toolCall?: string;
}

export function isInterruptibleEngine(engine: Engine): engine is InterruptibleEngine {
  return "kill" in engine && "isAlive" in engine && "killAll" in engine;
}

export interface EngineRunOpts {
  prompt: string;
  resumeSessionId?: string;
  systemPrompt?: string;
  cwd: string;
  bin?: string;
  model?: string;
  effortLevel?: string;
  attachments?: string[];
  historyMessages?: EngineHistoryMessage[];
  cliFlags?: string[];
  mcpConfigPath?: string;
  onStream?: (delta: StreamDelta) => void;
  onActivity?: () => void;
  sessionId?: string;
  source?: string;
  onLateRecovery?: (info: { result: string; sessionId: string }) => void;
  /** Hard-restrict this invocation to judge-only: no writes, no shell, no
   *  network fetch — for verdict/reviewer sessions that must only be able to
   *  read and reason, never act. Engine-enforced (not just prompt-instructed)
   *  where the underlying CLI supports it. */
  restrictToJudgeOnly?: boolean;
}

export interface EngineResult {
  sessionId: string;
  result: string;
  cost?: number;
  durationMs?: number;
  numTurns?: number;
  contextTokens?: number;
  error?: string;
  rateLimit?: EngineRateLimitInfo;
}

export type EngineFailureReason =
  | "rate_limit"
  | "quota_exhausted"
  | "engine_unavailable"
  | "timeout"
  | "auth_failure"
  | "context_overflow"
  | "unknown";

export type ModelFallbackMode = "ask_user" | "auto" | "never";

export interface ModelFallbackTarget {
  engine: string;
  model?: string;
  effortLevel?: string;
  employee?: string;
  reason?: string;
}

export interface ModelFallbackBehavior {
  mode?: ModelFallbackMode;
  triggers?: EngineFailureReason[];
  preserve_primary_session?: boolean;
  create_handoff_summary?: boolean;
  return_to_primary_when_available?: "ask_user" | "auto" | "never" | "stay_on_fallback";
}

export interface AgentModelPolicy {
  primary?: ModelFallbackTarget;
  fallback_chain?: ModelFallbackTarget[];
  fallback_behavior?: ModelFallbackBehavior;
}

export interface GlobalModelFallbackConfig {
  enabled?: boolean;
  defaultMode?: ModelFallbackMode;
  globalChain?: ModelFallbackTarget[];
  triggers?: Partial<Record<EngineFailureReason, boolean>>;
  handoff?: {
    createSummary?: boolean;
    includeArtifacts?: boolean;
    includeLogs?: boolean;
    includeOpenQuestions?: boolean;
    includeRecentTranscriptTurns?: number;
  };
  returnPolicy?: { whenPrimaryAvailable?: "ask_user" | "auto" | "never" | "stay_on_fallback" };
}

export interface EngineRateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  overageStatus?: string;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
}
