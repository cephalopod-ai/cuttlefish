/**
 * Strip Markdown syntax from text, leaving plain readable prose.
 *
 * Used in two places that must NOT show (or speak) raw markdown:
 *   - the Cuttlefish Talk transcript caption (mirrors spoken audio), and
 *   - `cleanPreview` (session preview labels), which layers @mention/#NNN
 *     stripping + capitalization on top.
 *
 * Newlines are PRESERVED (only horizontal whitespace is collapsed) so callers
 * that split on sentence/line boundaries — e.g. `splitSentences` driving the
 * per-sentence caption — keep their breaks. Callers that want a single line
 * (like `cleanPreview`) collapse newlines themselves afterwards.
 *
 * Intentionally regex-only (no markdown parser dependency): the goal is to drop
 * syntax characters, not to build an AST.
 */
export function stripMarkdown(raw: string): string {
  let text = raw
  // Headings: leading #'s followed by whitespace.
  text = text.replace(/^#{1,6}\s+/gm, "")
  // Emphasis — strip ONLY paired markers that WRAP content, so snake_case,
  // __dunder__, file_names, math (`2 * 3`) and URL underscores survive intact
  // (this text is now also read aloud by TTS, so over-stripping is a real
  // voice-fidelity loss, not just a cosmetic label issue).
  //   asterisks: ***x*** / **x** / *x*  (markers hug non-space content)
  text = text.replace(/\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*/g, "$1")
  text = text.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "$1")
  text = text.replace(/(?<![\w*])\*(?!\*)(?=\S)(.+?)(?<=\S)(?<!\*)\*(?![\w*])/g, "$1")
  //   single-underscore italic at word boundaries only (NOT inside identifiers
  //   and NOT the outer markers of a __dunder__ token).
  text = text.replace(/(?<![\w_])_(?!_)(?=\S)(.+?)(?<=\S)(?<!_)_(?![\w_])/g, "$1")
  // List markers (-, *, •, numbered) at line start.
  text = text.replace(/^[ \t]*[-*•]\s+/gm, "")
  text = text.replace(/^[ \t]*\d+[.)]\s+/gm, "")
  // Blockquotes.
  text = text.replace(/^>\s*/gm, "")
  // Code fence lines (incl. any info string — `ts`, `c++`, `ts title="x"`) —
  // BEFORE the inline-backtick strip, so the ``` delimiter and its tag are
  // dropped as a unit rather than leaving a stray `c++` line.
  text = text.replace(/^[ \t]*```.*$/gm, "")
  // Inline code backticks.
  text = text.replace(/`+/g, "")
  // Link syntax [text](url) → text.
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
  // Collapse horizontal whitespace only (keep newlines for sentence splitting),
  // trim whitespace around newlines, and cap blank-line runs.
  text = text.replace(/[^\S\n]+/g, " ")
  text = text.replace(/[^\S\n]*\n[^\S\n]*/g, "\n")
  text = text.replace(/\n{3,}/g, "\n\n")
  return text.trim()
}
