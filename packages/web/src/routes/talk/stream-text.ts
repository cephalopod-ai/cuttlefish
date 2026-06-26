/**
 * Cuttlefish Talk — pure stream-text helpers.
 *
 * Within one orchestrator turn the engine can emit MULTIPLE text content
 * blocks (e.g. narration before and after a tool call). The deltas arrive as
 * raw fragments with no separator at block boundaries, so naive concatenation
 * renders "…the Platform Lead now.On it. I'll surface…". We can't see block
 * boundaries from the delta stream, but a boundary is recognizable in the
 * text itself: accumulated text ending in sentence punctuation followed by a
 * fragment starting with a non-whitespace character. Mid-sentence token
 * deltas never look like that (they carry their own leading space), so the
 * heuristic is safe to run on every append.
 *
 * NOTE: the rehydrate path (rehydrate.ts) reads the server-persisted turn
 * text, which is already joined server-side — this helper is for the LIVE
 * delta accumulation only.
 */

/** True when `prev` ends a sentence: `.` `!` `?` or `…`. */
const SENTENCE_END = /[.!?…]$/

/**
 * Append a streamed `chunk` to the accumulated `prev`, inserting a single
 * space when the join straddles a content-block boundary (prev ends with
 * sentence punctuation, chunk starts with non-whitespace).
 */
export function joinStreamChunks(prev: string, chunk: string): string {
  if (!prev || !chunk) return prev + chunk
  if (SENTENCE_END.test(prev) && !/^\s/.test(chunk)) return `${prev} ${chunk}`
  return prev + chunk
}
