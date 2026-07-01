import { useMemo } from "react"
import { closePartialMarkdown, formatMessage } from "./message-markdown"

export function StreamingBubble({ streamingText }: { streamingText: string }) {
  const formattedContent = useMemo(
    () => formatMessage(closePartialMarkdown(streamingText)),
    [streamingText],
  )
  return (
    <div className="assistant-msg-row flex justify-start mb-[var(--space-1)]">
      <div className="assistant-msg-bubble flex flex-col">
        <div className="assistant-transcript py-[var(--space-1)] text-[var(--text-primary)] text-[length:var(--text-body)] leading-[var(--leading-relaxed)]">
          {formattedContent}
          <span className="stream-caret" aria-hidden="true" style={{ color: 'var(--accent)' }} />
        </div>
      </div>
    </div>
  )
}
