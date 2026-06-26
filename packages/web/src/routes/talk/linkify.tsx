/**
 * Cuttlefish Talk — linkify plain transcript text (Mission Control).
 *
 * The voice pipeline strips markdown, so URLs arrive as bare text. splitLinks()
 * is the pure splitter (unit-tested); <Linkified> renders the segments with
 * tappable anchors (pointer-events re-enabled — the transcript overlay is
 * pointer-events:none).
 */
import type { JSX } from "react"

export type LinkSegment =
  | { kind: "text"; text: string }
  | { kind: "link"; url: string; text: string }

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g

export function splitLinks(text: string): LinkSegment[] {
  const out: LinkSegment[] = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0]
    // Trailing sentence punctuation belongs to the prose, not the URL.
    const trimmed = url.replace(/[.,;:!?…—»]+$/, "")
    const tail = url.slice(trimmed.length)
    url = trimmed
    const start = m.index ?? 0
    if (start > last) out.push({ kind: "text", text: text.slice(last, start) })
    out.push({ kind: "link", url, text: url.replace(/^https?:\/\//, "") })
    last = start + m[0].length - tail.length
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) })
  return out.length ? out : [{ kind: "text", text }]
}

export function Linkified({ text }: { text: string }): JSX.Element {
  const segs = splitLinks(text)
  return (
    <>
      {segs.map((s, i) =>
        s.kind === "link" ? (
          // eslint-disable-next-line react/no-array-index-key
          <a key={i} className="talk-link" href={s.url} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>
            {s.text}
          </a>
        ) : (
          // eslint-disable-next-line react/no-array-index-key
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  )
}
