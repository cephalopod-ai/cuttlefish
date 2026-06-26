/**
 * Clean raw chat text for display as a preview label.
 * Strips @mentions, #NNN prefixes, markdown syntax, and capitalizes.
 *
 * Markdown removal is delegated to the shared `stripMarkdown` (also used by the
 * Talk transcript). The @mention/#NNN stripping and capitalization are
 * preview-specific and stay here.
 */
import { stripMarkdown } from "./strip-markdown"

const CACHE = new Map<string, string>()
const MAX = 200

export function cleanPreview(raw: string): string {
  if (CACHE.has(raw)) return CACHE.get(raw)!
  let text = raw
  // Strip @employee-name mentions
  text = text.replace(/@[\w-]+/g, "")
  // Strip #NNN session number prefixes
  text = text.replace(/^#\d+\s*/g, "")
  // Strip markdown syntax (shared helper)
  text = stripMarkdown(text)
  // Preview labels are single-line — collapse any remaining newlines.
  text = text.replace(/\s+/g, " ").trim()
  // Capitalize first letter
  if (text.length > 0 && text[0] !== text[0].toUpperCase()) {
    text = text[0].toUpperCase() + text.slice(1)
  }
  if (CACHE.size >= MAX) {
    const firstKey = CACHE.keys().next().value
    if (firstKey !== undefined) CACHE.delete(firstKey)
  }
  CACHE.set(raw, text)
  return text
}
