/**
 * Selects prompt sections under the context budget without dropping essential context.
 * Extracted from sessions/context.ts in a behavior-preserving modularization.
 * The compatibility facade uses Tier, Section and trimContext internally; no re-exports.
 */
// ── Tier enum for progressive trimming ────────────────────────
export const enum Tier {
  ESSENTIAL = 0,
  STANDARD = 1,
  OPTIONAL = 2,
}

export interface Section {
  tier: Tier;
  marker: string; // section heading metadata supplied by the context builder
  content: string;
  summary: string; // compact fallback when budget is tight
}

/**
 * Progressive trimming by tier: OPTIONAL sections are replaced with summaries first,
 * then STANDARD. ESSENTIAL sections are never trimmed, so the budget is best-effort.
 */
export function trimContext(sections: Section[], maxChars: number): string {
  let parts = sections.map(s => s.content);
  let result = parts.join("\n\n");
  if (result.length <= maxChars) return result;

  let length = result.length;

  // Trim OPTIONAL sections first, then STANDARD
  for (const tier of [Tier.OPTIONAL, Tier.STANDARD]) {
    for (let i = sections.length - 1; i >= 0; i--) {
      if (length <= maxChars) break;
      if (sections[i].tier === tier && sections[i].summary && sections[i].summary.length < parts[i].length) {
        length += sections[i].summary.length - parts[i].length;
        parts[i] = sections[i].summary;
      }
    }
  }

  return parts.join("\n\n");
}
