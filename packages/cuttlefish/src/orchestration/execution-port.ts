import type { Session, Engine, CuttlefishConfig } from "../shared/types.js";
import type { ApiContext } from "../gateway/api/context.js";

/**
 * Narrow execution port for orchestration lease turns (ARC-CUT-001).
 *
 * Orchestration must NOT statically import the gateway API aggregate
 * (`gateway/api.ts`) or its route-owned session-dispatch helper, because that
 * closes a real module cycle:
 *   gateway/api.ts -> api/orchestration-routes.ts -> orchestration/run-mode.ts -> gateway/api.ts
 *
 * Instead, orchestration depends on this port type. Callers may inject a
 * concrete dispatcher; when none is supplied, `run-mode.ts` resolves the
 * default gateway dispatcher via a lazy dynamic import, which does not create a
 * static module-graph edge and so keeps the cycle broken while preserving
 * behavior for every existing caller.
 */
export type WebSessionDispatcher = (
  session: Session,
  prompt: string,
  engine: Engine,
  config: CuttlefishConfig,
  context: ApiContext,
  opts?: { delayMs?: number; queueItemId?: string; attachments?: string[]; resourceContext?: string | null },
) => Promise<void>;

/**
 * Lazily resolve the default gateway web-session dispatcher without a static
 * import. The dynamic import is evaluated on first use, after all modules have
 * finished their top-level initialization, so it cannot reintroduce the cycle.
 */
export async function resolveDefaultWebSessionDispatcher(): Promise<WebSessionDispatcher> {
  const mod = await import("../gateway/api/session-dispatch.js");
  return mod.dispatchWebSessionRun;
}
