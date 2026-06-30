/**
 * Cuttlefish Talk — server-authoritative session graph (Mission Control).
 *
 * The talk UI renders the WHOLE delegation tree under the voice orchestrator —
 * AURA → COO children → employee grandchildren (any depth). The gateway owns
 * that tree: every session row carries parentSessionId, so membership is "does
 * walking up reach a source:'talk' session". Lifecycle call sites in
 * gateway/api.ts call maybeEmitTalkGraph() next to their existing session:*
 * emits; GET /api/talk/graph serves the snapshot for (re)connect rehydration.
 * Emission is best-effort — the snapshot endpoint is the source of truth.
 */
import type { Session } from "../shared/types.js";
import type { AttachMode } from "./attachments.js";
import { attachmentMode, talkSessionsAttachedTo } from "./attachments.js";
import { TALK_EVENTS } from "./protocol.js";

export interface TalkGraphNode {
  id: string;
  parentId: string | null;
  /** 1 = COO child of the talk root, 2 = employee under a COO, … */
  depth: number;
  label: string;
  employee: string | null;
  status: string;
  lastActivity: string;
  /** First ~140 chars of the session's prompt — "what was asked" of this node. */
  briefExcerpt?: string;
  /** True when this node is an ATTACHMENT (soft link), not an owned descendant. */
  attached?: true;
  /** Attachment mode — only present on attached nodes. */
  mode?: AttachMode;
}

export type TalkGraphChange =
  | "added"
  | "status"
  | "completed"
  | "removed"
  | "attached"
  | "detached";

const MAX_NODES = 200;

/** Human node label: title → employee → short id. */
function nodeLabel(s: Session): string {
  return (s.title && s.title.trim()) || s.employee || s.id.slice(0, 6);
}

export function toGraphNode(s: Session, depth: number): TalkGraphNode {
  return {
    id: s.id,
    parentId: s.parentSessionId ?? null,
    depth,
    label: nodeLabel(s),
    employee: s.employee ?? null,
    status: s.status,
    lastActivity: s.lastActivity,
    ...(s.promptExcerpt ? { briefExcerpt: s.promptExcerpt } : {}),
  };
}

/**
 * Attachment node: a session adopted by a talk root via a soft link. It renders
 * as a depth-1 satellite of that root (parentId = the talk root, NOT the
 * session's real parent, which lives elsewhere). `attached`/`mode` mark it.
 */
export function toAttachmentNode(
  s: Session,
  talkRootId: string,
  mode: AttachMode,
): TalkGraphNode {
  return {
    ...toGraphNode(s, 1),
    parentId: talkRootId,
    attached: true,
    mode,
  };
}

/** Walk parentSessionId links to the talk root (cycle-guarded). */
export function resolveTalkRoot(
  sessionId: string,
  getSession: (id: string) => Session | undefined,
): Session | undefined {
  const seen = new Set<string>();
  let cur = getSession(sessionId);
  while (cur) {
    if (cur.source === "talk") return cur;
    if (!cur.parentSessionId || seen.has(cur.id)) return undefined;
    seen.add(cur.id);
    cur = getSession(cur.parentSessionId);
  }
  return undefined;
}

/** Depth of a session below its talk root (1 = direct COO child). */
export function talkDepth(
  sessionId: string,
  getSession: (id: string) => Session | undefined,
): number {
  const seen = new Set<string>();
  let depth = 0;
  let cur = getSession(sessionId);
  while (cur && cur.source !== "talk" && cur.parentSessionId && !seen.has(cur.id)) {
    seen.add(cur.id);
    depth++;
    cur = getSession(cur.parentSessionId);
  }
  return depth;
}

/** Persisted attachments injected into a snapshot (read from the talk root's meta). */
export interface SnapshotAttachmentDeps {
  getSession: (id: string) => Session | undefined;
  listAttachments: (talkId: string) => Array<{ targetId: string; mode: AttachMode }>;
}

/**
 * BFS all descendants of a talk root (capped at MAX_NODES), then append the
 * root's attachment nodes at depth 1. An attachment that is ALSO a descendant of
 * the root (e.g. attaching your own grandchild) is skipped — the descendant walk
 * wins, so it appears once with its true depth.
 */
export function buildGraphSnapshot(
  rootId: string,
  listChildSessions: (parentId: string) => Session[],
  attachmentDeps?: SnapshotAttachmentDeps,
): TalkGraphNode[] {
  const nodes: TalkGraphNode[] = [];
  const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
  const seen = new Set<string>([rootId]);
  // Index cursor instead of queue.shift(): shift() is O(n) per call (it reindexes
  // the whole array), making this BFS O(n²). Advancing a head pointer keeps it O(n).
  let head = 0;
  while (head < queue.length && nodes.length < MAX_NODES) {
    const { id, depth } = queue[head++];
    for (const child of listChildSessions(id)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      nodes.push(toGraphNode(child, depth + 1));
      queue.push({ id: child.id, depth: depth + 1 });
    }
  }
  if (attachmentDeps) {
    for (const att of attachmentDeps.listAttachments(rootId)) {
      if (seen.has(att.targetId) || nodes.length >= MAX_NODES) continue;
      const target = attachmentDeps.getSession(att.targetId);
      if (!target) continue;
      seen.add(att.targetId);
      nodes.push(toAttachmentNode(target, rootId, att.mode));
    }
  }
  return nodes;
}

export interface TalkGraphEvent {
  rootId: string;
  change: TalkGraphChange;
  node: TalkGraphNode;
}

/**
 * Emit a talk:graph delta for every talk root this session belongs to. A session
 * is a member of a talk root either by DESCENT (its parent chain reaches the
 * root) or by ATTACHMENT (the root soft-linked it). Both are emitted: descendant
 * membership as a normal node, attachment membership as an attachment node. A
 * session attached to its own talk root is emitted once (descendant wins).
 *
 * Cheap no-op for the overwhelming majority of sessions (no talk root, no
 * attachment). Attachment lookups are in-memory only — after a restart, deltas
 * for a not-yet-touched talk root are best-effort; the snapshot endpoint (which
 * reads persisted meta) is the source of truth.
 */
export function maybeEmitTalkGraph(
  sessionId: string,
  change: TalkGraphChange,
  deps: {
    getSession: (id: string) => Session | undefined;
    emit: (event: string, payload: unknown) => void;
    /** Reverse attachment lookup — defaults to the in-memory registry. */
    talkSessionsAttachedTo?: (targetId: string) => string[];
    /** Attachment mode lookup — defaults to the in-memory registry. */
    attachmentMode?: (talkId: string, targetId: string) => AttachMode | undefined;
  },
): void {
  try {
    const session = deps.getSession(sessionId);
    if (!session || session.source === "talk") return;

    // Descendant membership — walk parent links up to a talk root.
    const descendantRoot = session.parentSessionId
      ? resolveTalkRoot(sessionId, deps.getSession)
      : undefined;
    if (descendantRoot) {
      const depth = talkDepth(sessionId, deps.getSession);
      deps.emit(TALK_EVENTS.graph, {
        rootId: descendantRoot.id,
        change,
        node: toGraphNode(session, depth),
      } satisfies TalkGraphEvent);
    }

    // Attachment membership — every talk root that soft-linked this session.
    const attachedTo = (deps.talkSessionsAttachedTo ?? talkSessionsAttachedTo)(sessionId);
    const modeOf = deps.attachmentMode ?? attachmentMode;
    for (const rootId of attachedTo) {
      if (descendantRoot && descendantRoot.id === rootId) continue; // descendant wins
      const mode = modeOf(rootId, sessionId) ?? "observe";
      deps.emit(TALK_EVENTS.graph, {
        rootId,
        change,
        node: toAttachmentNode(session, rootId, mode),
      } satisfies TalkGraphEvent);
    }
  } catch {
    /* best-effort — snapshot endpoint is the source of truth */
  }
}

/**
 * Emit an attachment lifecycle delta (attached / detached) to a talk root. Called
 * from the delegate endpoint on a successful attach/detach so the constellation
 * reflects the soft link immediately. `detached` carries the node so the client
 * can locate-and-remove it by id.
 */
export function emitAttachmentChange(
  talkRootId: string,
  target: Session,
  change: "attached" | "detached",
  mode: AttachMode,
  emit: (event: string, payload: unknown) => void,
): void {
  emit(TALK_EVENTS.graph, {
    rootId: talkRootId,
    change,
    node: toAttachmentNode(target, talkRootId, mode),
  } satisfies TalkGraphEvent);
}
