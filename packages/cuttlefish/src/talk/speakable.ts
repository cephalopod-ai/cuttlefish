/**
 * Cuttlefish Talk — server-side speech sanitizer.
 *
 * Converts a sentence (or flush remainder) into clean spoken text before
 * handing it to the TTS engine. Strips Markdown syntax, bare URLs, UUIDs,
 * bare hex identifiers, and machine protocol tags that the TTS engine would
 * otherwise read aloud literally ("asterisk asterisk", UUID strings, etc.).
 *
 * Port of the core logic from packages/web/src/lib/strip-markdown.ts with
 * additional speech-specific transforms. The web copy is intentionally left
 * untouched.
 *
 * Call on complete sentences / flush remainders, NOT on raw streaming deltas
 * (markdown tokens often split across delta boundaries).
 */

/**
 * Strip Markdown and machine-readable tokens from `text`, returning a plain
 * string safe for TTS synthesis. Returns an empty string when the input
 * contains nothing worth speaking (e.g. a bare code block or UUID).
 */
export function toSpeakable(text: string): string {
  let t = text;

  // 1. Remove entire fenced code blocks (``` ... ```) including their content.
  //    Must run before the inline-backtick strip so the fence delimiters and
  //    language tag are removed as a unit.
  t = t.replace(/```[\s\S]*?```/g, "");

  // 2. Headings: drop leading # markers (per line).
  t = t.replace(/^#{1,6}\s+/gm, "");

  // 3. Emphasis — strip ONLY paired markers that WRAP content (same
  //    conservative approach as the web stripMarkdown so snake_case,
  //    __dunder__, file_names and `2 * 3` survive intact).
  //    Bold-italic, bold, then italic (asterisk then underscore).
  t = t.replace(/\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*/g, "$1");
  t = t.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "$1");
  t = t.replace(/(?<![\w*])\*(?!\*)(?=\S)(.+?)(?<=\S)(?<!\*)\*(?![\w*])/g, "$1");
  // Single-underscore italic at word boundaries only.
  t = t.replace(/(?<![\w_])_(?!_)(?=\S)(.+?)(?<=\S)(?<!_)_(?![\w_])/g, "$1");

  // 4. List markers (-, *, •, numbered) at line start.
  t = t.replace(/^[ \t]*[-*•]\s+/gm, "");
  t = t.replace(/^[ \t]*\d+[.)]\s+/gm, "");

  // 5. Blockquotes.
  t = t.replace(/^>\s*/gm, "");

  // 6. Inline code backticks.
  t = t.replace(/`+/g, "");

  // 7. Machine protocol tags: [card-action ...] / [Route this ...] → removed.
  t = t.replace(/\[(card-action|Route this)[^\]]*\]/g, "");

  // 8. Markdown links [text](url) → text. Must run BEFORE bare-URL replacement
  //    so the URL inside a link is removed together with the parens rather than
  //    replaced with "the link on screen".
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

  // 9. Bare URLs → spoken proxy. Applied after markdown-link conversion so only
  //    URLs that appear naked in the text are replaced.
  t = t.replace(/https?:\/\/\S+/g, "the link on screen");

  // 10. UUID v4-ish patterns → removed.
  t = t.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    "",
  );

  // 11. Bare hex strings ≥ 12 chars (e.g. git SHAs, session IDs) → removed.
  t = t.replace(/\b[0-9a-f]{12,}\b/gi, "");

  // 12. Join lines: replace newlines (and surrounding horizontal space) with a
  //     single space so multi-line flush remainders read as one continuous
  //     spoken phrase.
  t = t.replace(/[^\S\n]*\n[^\S\n]*/g, " ");

  // 13. Collapse runs of whitespace and trim.
  t = t.replace(/\s{2,}/g, " ");
  t = t.trim();

  return t;
}
