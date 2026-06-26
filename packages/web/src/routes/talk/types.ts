/**
 * Cuttlefish Talk — shared type contract (Concept AURA).
 *
 * This is the spine every Talk component codes against: the avatar state
 * machine, the "Lego-block" content-card primitives the assistant composes on
 * the fly, and the parallel-task tracker. Keep this file dependency-free.
 */

/** The four moods of the AURA orb. Drives every visual transition. */
export type AvatarState = "idle" | "listening" | "thinking" | "speaking"

/** A normalised audio level 0..1, fed to the listening ring / speaking morph. */
export type AudioLevel = number

// ============================================================================
// Content cards — typed primitives the assistant summons only when useful.
// Discriminated union on `type`. Every card carries a stable `id` for keyed
// mount/unmount animation.
// ============================================================================

export interface CardBase {
  id: string
  /** Small mono eyebrow label, e.g. "TASK · CONTENT PIPELINE". */
  title?: string
  /** Optional right-aligned status word in the header, e.g. "RUNNING". */
  badge?: string
}

/** Prose / TL;DR answer block. */
export interface TextCard extends CardBase {
  type: "text"
  body: string
  /** Optional one-line distilled takeaway shown above the body. */
  tldr?: string
}

/** A single hero metric with optional delta. */
export interface StatCard extends CardBase {
  type: "stat"
  value: string
  label: string
  delta?: { dir: "up" | "down" | "flat"; value: string }
}

/** Bulleted / checklist list. */
export interface ListCard extends CardBase {
  type: "list"
  ordered?: boolean
  items: Array<{ text: string; done?: boolean }>
}

/** Single image with optional caption. */
export interface ImageCard extends CardBase {
  type: "image"
  src: string
  alt?: string
  caption?: string
}

/** A small gallery grid. */
export interface ImageGridCard extends CardBase {
  type: "image-grid"
  images: Array<{ src: string; alt?: string }>
}

/** Progress / status of a single job. */
export interface StatusCard extends CardBase {
  type: "status"
  label: string
  /** 0..1 */
  progress: number
  state: "queued" | "running" | "done" | "error"
  chips?: string[]
}

/** A live roll-up of sub-agents working in parallel. */
export interface AgentActivityCard extends CardBase {
  type: "agent-activity"
  agents: AgentActivity[]
}

/** External reference link. */
export interface LinkCard extends CardBase {
  type: "link"
  url: string
  label: string
  source?: string
}

// ----------------------------------------------------------------------------
// Decision-support cards — INTERACTIVE. The orchestrator pushes these when a
// child returns options to decide or approve; clicking a button sends a
// synthetic user message back to the orchestrator (the action channel), it
// does NOT mutate anything client-side. See use-talk `cardAction`.
// ----------------------------------------------------------------------------

/** A small key/value pair used in several decision cards. */
export interface CardKV {
  k: string
  v: string
}

/** Pick exactly one of several options (each option is a button). */
export interface ChoiceCard extends CardBase {
  type: "choice"
  prompt?: string
  options: Array<{
    id: string
    label: string
    detail?: string
    badge?: string
    meta?: CardKV[]
  }>
}

/** Side-by-side comparison table. */
export interface ComparisonCard extends CardBase {
  type: "comparison"
  columns: string[]
  rows: Array<{ label: string; cells: string[]; highlight?: number }>
}

/** Approve / reject a prepared (often irreversible) action. */
export interface ApprovalCard extends CardBase {
  type: "approval"
  summary: string
  details?: CardKV[]
  confirmLabel?: string
  rejectLabel?: string
  /** Red styling + emphasis when the action is destructive/irreversible. */
  danger?: boolean
}

/** A toned key/value readout (good/bad/neutral). */
export interface KeyValueCard extends CardBase {
  type: "keyvalue"
  rows: Array<{ k: string; v: string; tone?: "good" | "bad" | "neutral" }>
}

/** Before/after hunks (a config or code change). */
export interface DiffCard extends CardBase {
  type: "diff"
  hunks: Array<{ label?: string; before?: string; after?: string }>
}

export type Card =
  | TextCard
  | StatCard
  | ListCard
  | ImageCard
  | ImageGridCard
  | StatusCard
  | AgentActivityCard
  | LinkCard
  | ChoiceCard
  | ComparisonCard
  | ApprovalCard
  | KeyValueCard
  | DiffCard

export type CardType = Card["type"]

// ============================================================================
// Parallel-task tracker — multiple concurrent jobs the COO is running.
// ============================================================================

export type JobStatus = "queued" | "running" | "done" | "error"

export interface AgentActivity {
  id: string
  name: string
  role: string
  status: JobStatus
  detail?: string
  /** 0..1 */
  progress?: number
}

// ============================================================================
// Talk transcript — finalized conversation entries + system notifications.
// Consumed by ConversationStream (Task 9) and the rehydrate transforms.
// ============================================================================

/**
 * One finalized line of the talk conversation. Produced by the rehydrate
 * transforms (server snapshot → UI) and seeded into the ConversationStream
 * reducer. `partial` marks an assistant reply still streaming; `seg`/`full`
 * are legacy caption fields kept for the rehydrate shape and ignored by the
 * stream (which re-splits `full ?? text` into sentences itself).
 */
export interface TranscriptEntry {
  id: string
  role: "user" | "assistant"
  text: string
  partial?: boolean
  /** Sentence index while a reply is spoken (legacy caption field). */
  seg?: number
  /** Full reply text — the stream splits this into karaoke sentences. */
  full?: string
}

export type SystemEventKind = "reported" | "error" | "info"

/** A persisted delegation-notification row (`role:"notification"`) rehydrated
 *  as a typed system entry so the transcript survives a page reload. */
export interface SystemEntry {
  id: string
  kind: "system"
  event: SystemEventKind
  label: string
}
