import React, { useState } from "react"
import { useOpenFile } from "@/components/chat/file-open-context"

// Single source of truth for the file-path pattern: optional ~/ or / prefix,
// ≥1 slash-separated segment, ending in a short extension. Requiring a slash +
// an extension filters out branch names (feat/clickable-file-paths), mime types
// (text/markdown), version numbers (0.16.1) and bare words (config.yaml — no slash).
// Both the anchored test (isFilePath) and the inline-formatter alternative below
// derive from this core string so the two can never drift apart.
const FILE_PATH_CORE = String.raw`(?:~\/|\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]{1,8}`
const FILE_PATH_RE = new RegExp(`^${FILE_PATH_CORE}$`)

export function isFilePath(s: string): boolean {
  return FILE_PATH_RE.test(s.trim())
}

// Inline-formatter pattern, assembled from the shared FILE_PATH_CORE so the
// bare-path alternative (capture group 9) stays identical to FILE_PATH_RE.
// Groups: 1,2 md-link · 3 url · 4,5 bold · 6,7 inline-code · 8 italic · 9 path.
const INLINE_RE_SOURCE =
  String.raw`\[([^\]]+)\]\(([^)]+)\)` +                 // [text](url)
  String.raw`|(https?:\/\/[^\s<]+[^\s<.,;:!?)}\]'"])` + // bare URL
  String.raw`|(\*\*(.+?)\*\*)` +                        // **bold**
  "|(`([^`]+)`)" +                                      // `inline code`
  String.raw`|\*([^*]+)\*` +                            // *italic*
  `|(${FILE_PATH_CORE})`                                // bare file path

// Render a file path as a clean clickable link. Opens the file in an in-app tab
// when a FileOpenContext provider is present (chat page); otherwise / on
// modified clicks it falls back to the real `/file?path=` browser route.
// Monospace + blue underline (no code-box background — that looked like an empty highlight).
function FileLink({ path }: { path: string }) {
  const openFile = useOpenFile()
  const trimmed = path.trim()
  const href = `/file?path=${encodeURIComponent(trimmed)}`
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${trimmed} in viewer`}
      onClick={(e) => {
        // Let modified clicks (cmd/ctrl/shift/middle) fall through to a real browser tab.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        if (openFile) { e.preventDefault(); openFile(trimmed) }
      }}
      className="text-[var(--system-blue)] underline decoration-[var(--system-blue)]/40 hover:decoration-[var(--system-blue)] underline-offset-2 font-[family-name:var(--font-code)] text-[0.88em]"
    >
      {path}
    </a>
  )
}

function renderPathLink(p: string, key: React.Key): React.ReactNode {
  return <FileLink key={key} path={p} />
}

function safeMarkdownHref(href: string): string | null {
  const trimmed = href.trim()
  return /^(https?:\/\/|mailto:)/i.test(trimmed) ? trimmed : null
}

function inlineFormat(text: string): React.ReactNode {
  const parts: React.ReactNode[] = []
  // Fresh regex per call (own lastIndex — inlineFormat recurses for table cells).
  const regex = new RegExp(INLINE_RE_SOURCE, "g")
  let last = 0
  let match

  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    if (match[1] && match[2]) {
      // Markdown link: [text](url)
      const href = safeMarkdownHref(match[2])
      parts.push(href
        ? (
          <a
            key={match.index}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--system-blue)] underline underline-offset-2"
          >
            {match[1]}
          </a>
        )
        : match[1])
    } else if (match[3]) {
      // Bare URL
      parts.push(
        <a
          key={match.index}
          href={match[3]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--system-blue)] underline underline-offset-2"
        >
          {match[3]}
        </a>,
      )
    } else if (match[4]) {
      parts.push(<strong key={match.index} className="font-[var(--weight-bold)]">{match[5]}</strong>)
    } else if (match[6]) {
      // Inline `code` — but if it's actually a file path, make it a viewer link.
      // Agents almost always wrap paths in backticks, so this is the common case.
      if (isFilePath(match[7])) {
        parts.push(renderPathLink(match[7], match.index))
      } else {
        parts.push(
          <code key={match.index} className="bg-[var(--fill-secondary)] rounded-[5px] py-px px-[5px] text-[0.88em] font-[family-name:var(--font-code)] text-[var(--text-primary)]">{match[7]}</code>,
        )
      }
    } else if (match[8]) {
      parts.push(<em key={match.index} className="italic opacity-[0.85]">{match[8]}</em>)
    } else if (match[9]) {
      // Bare (un-backticked) file path -> viewer link
      parts.push(renderPathLink(match[9], match.index))
    }
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts.length === 1 ? parts[0] : <>{parts}</>
}

// Parse the language label off a ```fence line. Returns lowercased first token
// (e.g. ```tsx {3-5} -> "tsx"), or '' for a bare ``` fence.
export function parseFenceLang(line: string): string {
  const after = line.replace(/^```/, "").trim()
  if (!after) return ""
  return after.split(/\s+/)[0].toLowerCase()
}

function CodeBlock({ code, lang, keyProp }: { code: string; lang?: string; keyProp: number }) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    // Soft contained card — no hairline (fill + shadow-subtle). The header strip
    // lifts the copy button off the first line of code (fixes mobile overlap).
    <div key={keyProp} className="code-block-wrap my-[var(--space-2)] rounded-[var(--radius-md)] overflow-hidden bg-[var(--fill-tertiary)] shadow-[var(--shadow-subtle)]">
      <div className="flex items-center justify-between gap-[var(--space-2)] py-[3px] pl-[var(--space-3)] pr-[var(--space-1)] bg-[var(--fill-secondary)]">
        <span className="text-[length:var(--text-caption2)] tracking-wide text-[var(--text-tertiary)] font-[family-name:var(--font-code)]">
          {lang || "text"}
        </span>
        <button
          onClick={handleCopy}
          aria-label={copied ? "Copied" : "Copy code"}
          title={copied ? "Copied" : "Copy"}
          className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-[7px] border-none bg-transparent text-[var(--text-quaternary)] transition-colors hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)] cursor-pointer"
        >
          {copied ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
      </div>
      <pre className="code-block overflow-x-auto py-[var(--space-3)] px-[var(--space-4)] text-[length:var(--text-footnote)] leading-normal font-[family-name:var(--font-code)] text-[var(--text-primary)]"><code>{code}</code></pre>
    </div>
  )
}

function isTableSeparator(line: string): boolean {
  return /^\|[\s:|-]+\|$/.test(line.trim())
}

function parseTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim())
}

function TableBlock({ headerLine, rows, keyProp }: { headerLine: string; rows: string[]; keyProp: number }) {
  const headers = parseTableRow(headerLine)
  const bodyRows = rows.map(parseTableRow)

  return (
    <div key={keyProp} className="my-[var(--space-3)] rounded-[var(--radius-md)] overflow-hidden shadow-[var(--shadow-subtle)]">
      <div className="overflow-x-auto [WebkitOverflowScrolling:touch]">
        <table className="border-collapse text-[length:var(--text-footnote)] leading-[1.6] w-full min-w-max">
          <thead>
            <tr className="bg-[var(--fill-tertiary)]">
              {headers.map((h, hi) => (
                <th key={hi} className="text-left py-2.5 px-4 font-semibold text-[var(--text-primary)] max-w-[280px] break-words">{inlineFormat(h)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bodyRows.map((row, ri) => (
              <tr key={ri} className={ri % 2 === 1 ? "bg-[var(--fill-quaternary)]" : "bg-transparent"}>
                {row.map((cell, ci) => (
                  <td key={ci} className="py-2.5 px-4 text-[var(--text-primary)] max-w-[280px] break-words">{inlineFormat(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function formatMessage(content: string): React.ReactNode {
  if (!content) return null
  const lines = content.split("\n")
  const result: React.ReactNode[] = []
  let inCodeBlock = false
  let codeLines: string[] = []
  let codeLang = ""

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true
        codeLines = []
        codeLang = parseFenceLang(line)
      } else {
        inCodeBlock = false
        result.push(<CodeBlock key={i} keyProp={i} code={codeLines.join("\n")} lang={codeLang} />)
        codeLines = []
        codeLang = ""
      }
      continue
    }
    if (inCodeBlock) { codeLines.push(line); continue }

    // Table detection: header row | separator row | body rows
    if (line.trim().startsWith("|") && line.trim().endsWith("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headerLine = line
      i++ // skip separator
      const tableRows: string[] = []
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith("|") && lines[i + 1].trim().endsWith("|") && !isTableSeparator(lines[i + 1])) {
        i++
        tableRows.push(lines[i])
      }
      result.push(<TableBlock key={`table-${i}`} keyProp={i} headerLine={headerLine} rows={tableRows} />)
      continue
    }

    if (line.trim() === "") { result.push(<div key={`space-${i}`} className="h-1.5" />); continue }
    if (line.match(/^[-*] /)) {
      result.push(
        <div key={i} className="flex gap-[var(--space-2)] mb-1">
          <span className="text-[var(--text-tertiary)] shrink-0 mt-px">&bull;</span>
          <span>{inlineFormat(line.slice(2))}</span>
        </div>,
      )
      continue
    }
    if (line.match(/^\d+\. /)) {
      const num = line.match(/^(\d+)\. /)?.[1]
      result.push(
        <div key={i} className="flex gap-[var(--space-2)] mb-1">
          <span className="text-[var(--text-secondary)] shrink-0 font-[var(--weight-semibold)] min-w-4">{num}.</span>
          <span>{inlineFormat(line.replace(/^\d+\. /, ""))}</span>
        </div>,
      )
      continue
    }
    if (line.startsWith("### ")) {
      result.push(
        <div key={i} className="font-[var(--weight-semibold)] text-[length:var(--text-body)] mt-[var(--space-4)] mb-[var(--space-2)]">
          {inlineFormat(line.slice(4))}
        </div>,
      )
      continue
    }
    if (line.startsWith("## ")) {
      result.push(
        <div key={i} className="font-[var(--weight-bold)] text-[18px] mt-[var(--space-4)] mb-[var(--space-2)]">
          {inlineFormat(line.slice(3))}
        </div>,
      )
      continue
    }
    if (line.startsWith("# ")) {
      result.push(
        <div key={i} className="font-[var(--weight-bold)] text-[length:var(--text-title3)] mt-[var(--space-4)] mb-[var(--space-2)]">
          {inlineFormat(line.slice(2))}
        </div>,
      )
      continue
    }
    result.push(<div key={i} className="mb-[var(--space-2)] last:mb-0">{inlineFormat(line)}</div>)
  }

  // Close unclosed code block
  if (inCodeBlock && codeLines.length > 0) {
    result.push(<CodeBlock key="trailing-code" keyProp={999} code={codeLines.join("\n")} lang={codeLang} />)
  }

  return <>{result}</>
}

/**
 * Close unclosed markdown tokens so partial content renders cleanly.
 * Handles: code blocks (```), inline code (`), bold (**), italic (*).
 */
export function closePartialMarkdown(text: string): string {
  let result = text

  // Count triple backticks — if odd, close the code block
  const tripleBackticks = (result.match(/```/g) || []).length
  if (tripleBackticks % 2 !== 0) {
    result += "\n```"
  }

  // Only fix inline markers outside of code blocks
  if (tripleBackticks % 2 === 0) {
    // Count inline backticks outside code blocks (simplified: count ` not part of ```)
    const withoutCodeBlocks = result.replace(/```[\s\S]*?```/g, "")
    const inlineBackticks = (withoutCodeBlocks.match(/`/g) || []).length
    if (inlineBackticks % 2 !== 0) {
      result += "`"
    }

    // Count ** pairs
    const boldMarkers = (withoutCodeBlocks.match(/\*\*/g) || []).length
    if (boldMarkers % 2 !== 0) {
      result += "**"
    }
  }

  return result
}
