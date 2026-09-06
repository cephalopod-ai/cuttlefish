import type { StreamDelta } from "../shared/types.js";
import type { SseDataEvent } from "./sse-pty-proxy.js";

/**
 * UPS-A6: keep Claude Code's auto-compaction summary out of the chat.
 *
 * Compaction is an ordinary API call made through the same PTY and the same SSE
 * proxy as a real turn, carrying the same main-agent sentinel — so it passes
 * every tee gate and its summarizer output is streamed, persisted as an
 * assistant message, and carried onward into the run ledger and the knowledge
 * sink as if the session had said it. Upstream jinn measured ~25K characters of
 * it appearing mid-turn.
 *
 * The one stable marker is the opening tag: a compaction response is the only
 * assistant message that begins with `<analysis>`. So hold each message's first
 * characters until that is decided, and drop the whole message when it matches.
 * Anything else is released in order, unchanged.
 */

const MARKER = "<analysis>";
/**
 * Give up holding after this much leading text. Only reached by a message that
 * opens with a long run of whitespace; releasing is the safe answer, since the
 * marker cannot still be ahead of us.
 */
const MAX_HOLD_CHARS = 64;

type Decision = "hold" | "release" | "drop";

function decide(seen: string): Decision {
  const trimmed = seen.trimStart();
  if (trimmed.length >= MARKER.length) {
    return trimmed.startsWith(MARKER) ? "drop" : "release";
  }
  if (seen.length >= MAX_HOLD_CHARS) return "release";
  // Still short: only keep holding while what we have could still grow into the
  // marker. "<ana" can; "Sure," cannot.
  return MARKER.startsWith(trimmed) ? "hold" : "release";
}

export class CompactionStreamGate {
  /** Text seen so far in the current message, before a verdict was reached. */
  private seen = "";
  /** Text deltas withheld pending a verdict. */
  private held: StreamDelta[] = [];
  private decided = false;
  private dropping = false;

  /** Whether the message currently in flight was judged to be a compaction. */
  get isDroppingMessage(): boolean {
    return this.decided && this.dropping;
  }

  private reset(): void {
    this.seen = "";
    this.held = [];
    this.decided = false;
    this.dropping = false;
  }

  /**
   * Filter one SSE event's deltas. Returns what may be forwarded now — which
   * may be more than was passed in (a release flushes what was held) or fewer
   * (a hold, or a dropped compaction message).
   */
  filter(event: SseDataEvent, deltas: StreamDelta[]): StreamDelta[] {
    if (event.type === "message_start") {
      // A message that ended without ever resolving leaves nothing useful
      // behind; a new message starts from a clean slate either way.
      this.reset();
    }

    const out: StreamDelta[] = [];
    for (const delta of deltas) {
      // Only assistant text can carry the marker. Context meters and tool
      // markers are structural and always pass, so a compaction call still
      // reports the context size it consumed.
      if (delta.type !== "text") {
        out.push(delta);
        continue;
      }
      if (this.decided) {
        if (!this.dropping) out.push(delta);
        continue;
      }
      this.seen += delta.content;
      this.held.push(delta);
      const verdict = decide(this.seen);
      if (verdict === "hold") continue;
      this.decided = true;
      if (verdict === "drop") {
        this.dropping = true;
        this.held = [];
        continue;
      }
      out.push(...this.held);
      this.held = [];
    }

    // The message ended while still undecided — it never matched, so whatever
    // was held is ordinary output and must not be swallowed.
    if (event.type === "message_stop" && !this.decided && this.held.length > 0) {
      out.push(...this.held);
      this.held = [];
      this.decided = true;
    }

    return out;
  }

  /**
   * Release anything still held because the stream ended mid-message (a PTY
   * crash, a dropped SSE connection). Silence is a worse failure than showing
   * a partial line, so undecided text is flushed rather than lost.
   */
  flush(): StreamDelta[] {
    if (this.decided || this.held.length === 0) return [];
    const held = this.held;
    this.held = [];
    this.decided = true;
    return held;
  }
}
