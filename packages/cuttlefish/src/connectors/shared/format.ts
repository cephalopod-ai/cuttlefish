/**
 * Shared formatting helpers for connector format modules.
 * Each platform keeps its own markdown converter and length limit;
 * the chunking algorithm lives here.
 */

/**
 * Apply a conversion to the non-code segments of a markdown text,
 * leaving code blocks and inline code untouched.
 */
export function convertOutsideCode(
  text: string,
  convert: (segment: string) => string,
): string {
  // Split text into code and non-code segments to protect code from conversion
  const segments = text.split(/(```[\s\S]*?```|`[^`]+`)/g);

  return segments
    .map((segment, i) => {
      // Odd indices are code matches — leave them untouched
      if (i % 2 === 1) return segment;
      return convert(segment);
    })
    .join("");
}

/**
 * Split text into chunks that fit within a platform's message length limit,
 * preferring newline boundaries, then spaces, then a hard split.
 */
export function chunkText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline boundary within the limit
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex <= 0) {
      // Fall back to splitting at a space
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIndex <= 0) {
      // Hard split if no good boundary found
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}

/**
 * Convert text with the platform's markdown converter, then split into
 * chunks under the platform's message length limit.
 */
export function formatAndChunk(
  text: string,
  maxLength: number,
  converter?: (text: string) => string,
): string[] {
  return chunkText(converter ? converter(text) : text, maxLength);
}
