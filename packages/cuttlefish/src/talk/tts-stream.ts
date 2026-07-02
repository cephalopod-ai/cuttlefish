/**
 * Cuttlefish Talk — server-side TTS streaming (Mission Control: per-sentence).
 *
 * As the orchestrator streams its reply, the run loop (api.ts) feeds each text
 * delta via feedTalkText(); complete sentences are synthesized IMMEDIATELY
 * (killing the old whole-turn dead air) on a per-session serial chain that
 * keeps talk:audio `seq` monotonic across the turn. flushTalkSpeech() speaks
 * the remainder with `final:true` (the only chunk allowed to carry last:true).
 * Calling feedTalkText without an emitter falls back to the legacy
 * buffer-everything behavior (everything speaks on flush).
 *
 * The Kokoro engine is a process-wide singleton shared with routes.ts (status /
 * download endpoints) so there is exactly one sidecar.
 */
import { createKokoroTts } from "./kokoro.js";
import type { Tts, Emit } from "./protocol.js";
import { logger } from "../shared/logger.js";
import { toSpeakable } from "./speakable.js";

type KokoroOpts = Parameters<typeof createKokoroTts>[0];

let engine: Tts | null = null;

/** The shared Kokoro engine (lazily constructed with the live config). */
export function getTalkTts(opts?: KokoroOpts): Tts {
  if (!engine) engine = createKokoroTts(opts);
  return engine;
}

/** Test seam: swap the singleton for a mock. */
export function __setTalkTtsForTest(tts: Tts | null): void {
  engine = tts;
}

/**
 * Gateway-shutdown hook: kill the Kokoro sidecar if one was ever spawned.
 * Deliberately does NOT construct the engine just to tear it down — if TTS was
 * never used this session there is no sidecar to stop.
 */
export function shutdownTalkTts(): void {
  engine?.shutdown();
}

/**
 * Max characters accepted by POST /api/tts in a single read-aloud call. Bounds
 * the sidecar's synth time and the WAV response size (≈ a few minutes of audio).
 */
export const TTS_MAX_CHARS = 8000;

/**
 * Validate + bound the `text` field of a POST /api/tts request. Trims, rejects
 * non-strings and empties, and caps over-long input at the last sentence/space
 * boundary before the limit so a word is never cut mid-token. Pure — unit-tested.
 */
export function validateTtsText(
  raw: unknown,
  maxChars = TTS_MAX_CHARS,
): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "text must be a string" };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "text must be a non-empty string" };
  if (trimmed.length <= maxChars) return { ok: true, text: trimmed };
  const head = trimmed.slice(0, maxChars);
  // Prefer a clean cut at a sentence/newline/space boundary in the back half of
  // the window; if none (e.g. one giant token), hard-slice at the cap.
  const boundary = Math.max(head.lastIndexOf(". "), head.lastIndexOf("\n"), head.lastIndexOf(" "));
  const text = (boundary > maxChars / 2 ? head.slice(0, boundary + 1) : head).trim();
  return { ok: true, text };
}

/**
 * Standalone one-shot synthesis for POST /api/tts: returns a single WAV buffer
 * for the whole text. Reuses the shared Kokoro engine; rejects when unavailable.
 */
export async function synthesizeText(text: string, opts?: KokoroOpts): Promise<Buffer> {
  return getTalkTts(opts).synthesize(text);
}

/** TTS engine readiness for GET /api/tts — no synth, no sidecar spawn. */
export function ttsStatus(opts?: KokoroOpts): { available: boolean; voice: string } {
  const s = getTalkTts(opts).status();
  return { available: s.available, voice: s.voice };
}

/**
 * Split already-markdown-stripped prose into sentence-sized chunks for streamed
 * read-aloud. Splits on sentence terminators (followed by whitespace) AND on
 * newlines (list items / paragraphs), collapsing inner whitespace and dropping
 * empties. Pure — unit-tested. Text with no terminator stays one chunk.
 */
export function splitTtsSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
}

/**
 * Synthesize `text` sentence-by-sentence, invoking `onFrame` with each sentence's
 * WAV as soon as it's ready — so the client can PLAY sentence 1 while 2..N are
 * still synthesizing (time-to-first-audio ≈ one sentence, not the whole message).
 *
 * Kokoro is one-request-at-a-time, so synthesis is naturally sequential; that's
 * fine since playback is sequential too. `isCancelled` is checked before and
 * after each synth so a paused/aborted client stops further synthesis promptly
 * (we don't keep synthesizing a message nobody is listening to). Resolves with
 * the number of frames emitted.
 */
export async function streamTtsSentences(
  text: string,
  opts: KokoroOpts | undefined,
  onFrame: (wav: Buffer) => void,
  isCancelled: () => boolean,
): Promise<number> {
  const sentences = splitTtsSentences(text);
  let count = 0;
  for (const sentence of sentences) {
    if (isCancelled()) break;
    const wav = await getTalkTts(opts).synthesize(sentence);
    if (isCancelled()) break;
    onFrame(wav);
    count++;
  }
  return count;
}

interface TurnState {
  buffer: string;
  seq: number;
  /** Serial synth chain — keeps chunk order while sentences stream in. */
  chain: Promise<void>;
  /** Bumped by discard; queued-but-unstarted sentences check it and drop. */
  epoch: number;
  /** A synth failure stops mid-turn streaming for the rest of the turn. */
  failed: boolean;
  /** flushTalkSpeech sets this; the next feed then starts a fresh turn. */
  finalized: boolean;
  /** True once this turn's first sentence has chained after the predecessor tail. */
  waited: boolean;
}

const turns = new Map<string, TurnState>();
/**
 * Last (or in-flight) synth chain per session. A NEW turn chains its first
 * sentence after this so all of turn N's audio events — including its `last:true`
 * — are emitted strictly before any of turn N+1's. Without it, a turn that begins
 * while the previous turn's synth is still pending interleaves their audio events,
 * and turn N's `last:true` can land after turn N+1's first chunks (the frontend
 * reads that as stream-end → silence until the next user gesture resumes audio).
 */
const tails = new Map<string, Promise<void>>();

function getTurn(sessionId: string): TurnState {
  let t = turns.get(sessionId);
  // A finalized turn is awaiting its own tail; the next feed starts a fresh turn
  // (which will chain after that tail) rather than appending to the closed one.
  if (!t || t.finalized) {
    t = { buffer: "", seq: 0, chain: Promise.resolve(), epoch: 0, failed: false, finalized: false, waited: false };
    turns.set(sessionId, t);
  }
  return t;
}

/**
 * Pull complete sentences off the front of `buffer` (terminator + whitespace),
 * returning them plus the incomplete remainder. "3.14" never splits (no
 * whitespace after the dot).
 */
export function extractSentences(buffer: string): { complete: string[]; rest: string } {
  const complete: string[] = [];
  let rest = buffer;
  for (;;) {
    const m = rest.match(/^([\s\S]*?[.!?…])(\s+)/);
    if (!m) break;
    const sentence = m[1].trim();
    if (sentence) complete.push(sentence);
    rest = rest.slice(m[0].length);
  }
  return { complete, rest };
}

function queueSentence(sessionId: string, t: TurnState, text: string, opts: KokoroOpts | undefined, emit: Emit, final: boolean): void {
  const epoch = t.epoch;
  // The turn's FIRST sentence waits for the previous turn's tail so this turn's
  // events never interleave with the predecessor's (later sentences chain off
  // t.chain and inherit the wait). Cleared after one use so we wait at most once.
  const prevTail = t.waited ? undefined : tails.get(sessionId);
  t.waited = true;
  t.chain = t.chain.then(async () => {
    if (prevTail) {
      try { await prevTail; } catch { /* predecessor failure must not strand us */ }
    }
    if (t.epoch !== epoch || t.failed) return;
    const speakable = toSpeakable(text);
    if (!speakable) return; // nothing worth speaking — do NOT bump seq; if this is the FINAL flush remainder, the turn emits no last:true — same as the pre-existing empty-remainder path; the frontend re-arms via its drain/idle path, so this is safe
    try {
      const n = await getTalkTts(opts).speak(sessionId, speakable, emit, { seqStart: t.seq, final });
      t.seq += n;
    } catch (err) {
      t.failed = true;
      logger.warn(
        `[talk] TTS speak failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}

/**
 * Append a streamed text delta. With an emitter, complete sentences are
 * synthesized immediately (per-sentence streaming); without one, text only
 * accumulates and flushTalkSpeech speaks it all (legacy single-call path).
 */
export function feedTalkText(sessionId: string, text: string, opts?: KokoroOpts, emit?: Emit): void {
  if (!text) return;
  const t = getTurn(sessionId);
  t.buffer += text;
  if (!emit || t.failed) return;
  const { complete, rest } = extractSentences(t.buffer);
  if (complete.length === 0) return;
  t.buffer = rest;
  for (const sentence of complete) queueSentence(sessionId, t, sentence, opts, emit, false);
}

/**
 * Speak whatever remains for this turn (final chunk carries last:true), then
 * clear the per-session state. Awaitable; safe to fire-and-forget.
 */
export async function flushTalkSpeech(
  sessionId: string,
  opts: KokoroOpts | undefined,
  emit: Emit,
): Promise<void> {
  const t = turns.get(sessionId);
  if (!t) return;
  const rest = t.buffer.trim();
  t.buffer = "";
  if (rest && !t.failed) queueSentence(sessionId, t, rest, opts, emit, true);
  // Mark finalized (the next feed starts a fresh turn) and publish this turn's
  // chain as the tail the next turn must wait for. We do NOT delete the state
  // up front: a back-to-back next turn needs the tail to remain resolvable.
  t.finalized = true;
  const chain = t.chain;
  tails.set(sessionId, chain);
  await chain;
  // Only clean up if a successor turn hasn't already taken our slots (never
  // delete a successor's state or retarget its tail).
  if (turns.get(sessionId) === t) turns.delete(sessionId);
  if (tails.get(sessionId) === chain) tails.delete(sessionId);
}

/** Drop any buffered/queued text for a session without speaking (interrupt). */
export function discardTalkSpeech(sessionId: string): void {
  const t = turns.get(sessionId);
  if (!t) return;
  t.epoch++;
  t.buffer = "";
  turns.delete(sessionId);
  // Don't let the next turn chain after interrupted work.
  tails.delete(sessionId);
}
