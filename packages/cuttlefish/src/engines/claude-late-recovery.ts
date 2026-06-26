import type { EngineRunOpts } from "../shared/types.js";
import type { HookRegistry } from "../gateway/hook-registry.js";
import { logger } from "../shared/logger.js";
import { stripReasoningBlocks } from "./claude-interactive-transcript.js";

const LATE_RECOVERY_WINDOW_MS = 10 * 60 * 1000;

/** Listens briefly for a late Stop hook after Claude reported an API failure. */
export class ClaudeLateRecovery {
  private lateRecovery = new Map<string, { timer: NodeJS.Timeout }>();

  constructor(private hookRegistry: HookRegistry) {}

  arm(cuttlefishSessionId: string, opts: EngineRunOpts): void {
    if (!opts.onLateRecovery) return;
    this.cancel(cuttlefishSessionId);
    const timer = setTimeout(() => this.cancel(cuttlefishSessionId), LATE_RECOVERY_WINDOW_MS);
    timer.unref?.();
    this.lateRecovery.set(cuttlefishSessionId, { timer });
    this.hookRegistry.register(cuttlefishSessionId, (h) => {
      if (h.hook_event_name !== "Stop") return;
      const text = String(h.last_assistant_message ?? "");
      const sid = typeof h.session_id === "string" ? h.session_id : "";
      this.cancel(cuttlefishSessionId);
      const safeText = stripReasoningBlocks(text);
      if (safeText.trim()) {
        logger.info(`InteractiveClaudeEngine: late Stop superseded failed turn for ${cuttlefishSessionId}`);
        opts.onLateRecovery?.({ result: safeText, sessionId: sid });
      } else {
        logger.info(`InteractiveClaudeEngine: late Stop with no text for ${cuttlefishSessionId} — recovery abandoned`);
      }
    });
  }

  cancel(cuttlefishSessionId: string): void {
    const lr = this.lateRecovery.get(cuttlefishSessionId);
    if (!lr) return;
    clearTimeout(lr.timer);
    this.lateRecovery.delete(cuttlefishSessionId);
    this.hookRegistry.unregister(cuttlefishSessionId);
  }
}
