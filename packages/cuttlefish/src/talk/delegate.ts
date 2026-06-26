/**
 * Cuttlefish Talk — server-owned delegation (Mission Control).
 *
 * One endpoint owns spawn-vs-continue so the orchestrator LLM never decides it
 * from prose: `thread:"new"` spawns a COO child; `thread:"<id>"` validates the
 * id is a live child of THIS talk session and posts a follow-up. Unknown ids
 * fail with the live roster in the body — a self-correcting error for the model.
 * Spawning/continuing goes through the normal /api/sessions HTTP routes (via
 * injected deps) so queueing, talk:focus, and parent callbacks behave exactly
 * as a hand-rolled curl did.
 */
import type { Session } from "../shared/types.js";
import type { Attachment, AttachMode, AttachResult } from "./attachments.js";

export interface DelegateDeps {
  getSession: (id: string) => Session | undefined;
  listChildSessions: (parentId: string) => Session[];
  /**
   * Internal POST /api/sessions — spawn a COO child; resolves to the new id.
   * `promptExcerpt` (optional) overrides the list-UI excerpt so it shows the
   * operator's ask instead of the scaffolded delegation prompt.
   */
  spawnChild: (opts: {
    prompt: string;
    parentSessionId: string;
    promptExcerpt?: string;
  }) => Promise<{ id: string }>;
  /** Internal POST /api/sessions/:id/message — continue an existing thread. */
  continueThread: (sessionId: string, message: string) => Promise<void>;
  updateSession: (id: string, updates: { title?: string }) => unknown;
  emit: (event: string, payload: unknown) => void;
  /** Attachments registry (bound to the talk session's persisted meta). */
  attachments: {
    attach: (talkId: string, targetId: string, mode: AttachMode) => AttachResult;
    detach: (talkId: string, targetId: string) => boolean;
    list: (talkId: string) => Attachment[];
  };
  /**
   * Emit an attachment lifecycle delta to the talk graph (attached / detached).
   * Injected (graph.ts) so the constellation reflects the soft link immediately.
   * Optional — delegation works without it.
   */
  emitAttachmentChange?: (
    talkRootId: string,
    target: Session,
    change: "attached" | "detached",
    mode: AttachMode,
  ) => void;
}

export type DelegateResult =
  | { ok: true; threadId: string; created: boolean }
  | { ok: true; threadId: string; attached: true; mode: AttachMode }
  | { ok: true; threadId: string; detached: true }
  | {
      ok: false;
      status: number;
      error: string;
      threads?: Array<{ id: string; label: string; status: string }>;
      attachments?: Attachment[];
    };

/** Compact roster of a talk session's COO children (for self-correcting errors). */
export function threadRoster(deps: DelegateDeps, talkSessionId: string) {
  return deps.listChildSessions(talkSessionId).map((c) => ({
    id: c.id,
    label: c.title || "(untitled)",
    status: c.status,
  }));
}

/** Derive a ≤36-char title from the brief when no label is given. */
function defaultLabel(brief: string): string {
  const s = brief.replace(/\s+/g, " ").trim();
  return s.length > 36 ? s.slice(0, 35).trimEnd() + "…" : s;
}

const PROVENANCE_PREFIX = "[Relayed by AURA on behalf of the operator]\n\n";

/**
 * The "original words win" block, appended verbatim after a brief. Identical for
 * owned children and engage-relays — the only difference is the provenance prefix
 * (added by the caller for non-owned targets).
 */
function verbatimBlock(utterance: string): string {
  return (
    `\n\n---\nOperator's original request (verbatim): "${utterance}"\n` +
    "If the brief above misreads this, the original words win."
  );
}

/** Owned-child message: brief, plus the verbatim block when an utterance is present. */
function ownedMessage(brief: string, utterance?: string): string {
  return utterance ? brief + verbatimBlock(utterance) : brief;
}

/** Engage-relay message: provenance prefix is ALWAYS added; verbatim only with an utterance. */
function relayMessage(brief: string, utterance?: string): string {
  return PROVENANCE_PREFIX + (utterance ? brief + verbatimBlock(utterance) : brief);
}

export async function delegateToThread(
  body: unknown,
  deps: DelegateDeps,
): Promise<DelegateResult> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, error: "body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.sessionId !== "string" || !b.sessionId.trim()) {
    return {
      ok: false,
      status: 400,
      error: "sessionId must be a non-empty string (your own talk session id)",
    };
  }
  const talk = deps.getSession(b.sessionId);
  if (!talk || talk.source !== "talk") {
    return {
      ok: false,
      status: 400,
      error: `sessionId ${b.sessionId} is not a talk session`,
    };
  }

  // Operator's original words (optional everywhere). Empty/blank → treated as absent.
  const utterance =
    typeof b.utterance === "string" && b.utterance.trim().length > 0 ? b.utterance : undefined;

  // ── detach ───────────────────────────────────────────────────────────
  // Remove an attachment. No message is sent. `thread` carries the target id.
  if (b.detach === true) {
    if (typeof b.thread !== "string" || !b.thread.trim()) {
      return { ok: false, status: 400, error: "thread must be the attached session id to detach" };
    }
    const targetId = b.thread.trim();
    const roster = deps.attachments.list(talk.id);
    const existing = roster.find((a) => a.targetId === targetId);
    if (!existing) {
      return {
        ok: false,
        status: 400,
        error: `${targetId} is not attached to this talk session — nothing to detach`,
        attachments: roster,
      };
    }
    deps.attachments.detach(talk.id, targetId);
    const detachedTarget = deps.getSession(targetId);
    if (detachedTarget) {
      deps.emitAttachmentChange?.(talk.id, detachedTarget, "detached", existing.mode);
    }
    return { ok: true, threadId: targetId, detached: true };
  }

  // ── attach ───────────────────────────────────────────────────────────
  // Adopt ANY session (employee/COO/chat) as an observe/engage target. The
  // parent-ownership check is intentionally SKIPPED — attachments are soft links.
  if (b.attach === true) {
    if (typeof b.thread !== "string" || !b.thread.trim()) {
      return { ok: false, status: 400, error: "thread must be the session id to attach" };
    }
    const targetId = b.thread.trim();
    const target = deps.getSession(targetId);
    if (!target) {
      return { ok: false, status: 400, error: `attach target ${targetId} does not exist` };
    }
    if (target.source === "talk") {
      return { ok: false, status: 400, error: `cannot attach a talk session (${targetId})` };
    }
    if (deps.attachments.list(talk.id).some((a) => a.targetId === targetId)) {
      return { ok: false, status: 400, error: `${targetId} is already attached to this talk session` };
    }

    let mode: AttachMode = "observe";
    if (b.mode !== undefined) {
      if (b.mode !== "observe" && b.mode !== "engage") {
        return { ok: false, status: 400, error: 'mode must be "observe" or "engage"' };
      }
      mode = b.mode;
    }

    const brief = typeof b.brief === "string" && b.brief.trim() ? b.brief.trim() : undefined;
    if (mode === "observe" && brief) {
      return {
        ok: false,
        status: 400,
        error: 'observe mode cannot send messages — attach with mode "engage"',
      };
    }

    const reg = deps.attachments.attach(talk.id, targetId, mode);
    if (!reg.ok) {
      return { ok: false, status: 400, error: reg.error };
    }
    deps.emitAttachmentChange?.(talk.id, target, "attached", mode);
    // engage + brief → relay a provenance-stamped message to the adopted session.
    if (mode === "engage" && brief) {
      await deps.continueThread(targetId, relayMessage(brief, utterance));
    }
    return { ok: true, threadId: targetId, attached: true, mode };
  }

  if (typeof b.brief !== "string" || !b.brief.trim()) {
    return {
      ok: false,
      status: 400,
      error: "brief must be a non-empty string (the expanded task brief)",
    };
  }
  const brief = b.brief.trim();
  if (typeof b.thread !== "string" || !b.thread.trim()) {
    return {
      ok: false,
      status: 400,
      error: 'thread must be "new" or an existing COO thread id',
      threads: threadRoster(deps, talk.id),
    };
  }

  if (b.thread === "new") {
    const label =
      typeof b.label === "string" && b.label.trim()
        ? b.label.trim().slice(0, 64)
        : defaultLabel(brief);
    const { id } = await deps.spawnChild({
      prompt: ownedMessage(brief, utterance),
      parentSessionId: talk.id,
      // The operator's verbatim ask makes a far better ThreadCard excerpt than
      // the scaffolded prompt (brief + "--- Operator's original request…").
      promptExcerpt: utterance,
    });
    deps.updateSession(id, { title: label });
    deps.emit("talk:thread:label", { sessionId: talk.id, threadId: id, label });
    return { ok: true, threadId: id, created: true };
  }

  const child = deps.getSession(b.thread);
  if (!child || child.parentSessionId !== talk.id) {
    return {
      ok: false,
      status: 400,
      error: `thread ${b.thread} is not one of your COO threads — use "new" or one of the ids below`,
      threads: threadRoster(deps, talk.id),
    };
  }
  await deps.continueThread(child.id, ownedMessage(brief, utterance));
  return { ok: true, threadId: child.id, created: false };
}
