import React, { useMemo } from "react"
import type { Message } from "@/lib/conversations"
import { parseMedia, stripAttachedFilesBlock } from "@/lib/conversations"
import { blockFallbackContent } from "@/lib/blocks"
import { ChatBlockInline } from "./chat-blocks"
import { MessageMedia } from "./message-media"
import { CollapsibleUserText } from "./collapsible-user-text"
import { MessageActions } from "./message-actions"
import { formatMessage } from "./message-markdown"
import { formatTimestamp, shouldShowTimestamp } from "./message-time"

interface MessageRowProps {
  msg: Message
  index: number
  messages: Message[]
  loading?: boolean
  onRetry?: (text: string) => void
}

export const MessageRow = React.memo(function MessageRow({ msg, index: i, messages, loading, onRetry }: MessageRowProps) {
  const isUser = msg.role === "user"
  const isNotification = msg.role === "notification"
  const showTimestamp = shouldShowTimestamp(messages, i)
  const media = msg.media || parseMedia(msg.content)
  const blocks = msg.blocks || []
  const hasBlocks = blocks.length > 0

  // Strip media URLs from text for display
  let textContent = msg.content
  if (media.length > 0 && !msg.media) {
    media.forEach(m => {
      textContent = textContent.replace(m.url, "")
      textContent = textContent.replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    })
    textContent = textContent.trim()
  }
  // Defensive: never show the engine-only "Attached files:\n- /abs/path" block that
  // gets appended to the prompt for the CLI. Attachments render as chips/thumbnails.
  textContent = stripAttachedFilesBlock(textContent)
  // Hide auto-generated content labels for media-only messages
  if (msg.media && msg.media.length > 0) {
    const isAutoLabel = textContent.startsWith("[") && textContent.endsWith("]")
    if (isAutoLabel) textContent = ""
  }
  const isBlockFallbackText = hasBlocks && blocks.some((block) => {
    const content = textContent.trim()
    return content === blockFallbackContent(block).trim()
      || content === (block.title || "").trim()
      || content === (block.summary || "").trim()
  })
  if (isBlockFallbackText) textContent = ""

  // Memoize the expensive formatting — re-runs only when textContent changes
  const formattedContent = useMemo(() => formatMessage(textContent), [textContent])

  // Memoize timestamp formatting — avoids Date allocations on every parent re-render
  const formattedTimestamp = useMemo(() => formatTimestamp(msg.timestamp), [msg.timestamp])

  // Retry resends the user message that prompted this assistant reply (the gateway
  // has no in-place regenerate, so re-sending the prior prompt is the honest action).
  const prevUserText = useMemo(() => {
    if (isUser || isNotification) return ""
    for (let j = i - 1; j >= 0; j--) {
      if (messages[j].role === "user" && messages[j].content.trim()) return messages[j].content
    }
    return ""
  }, [messages, i, isUser, isNotification])

  return (
    <div key={msg.id || i}>
      {/* Timestamp divider */}
      {showTimestamp && (
        <div className="text-center py-[var(--space-3)] text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
          {formattedTimestamp}
        </div>
      )}

      {/* Spacing between role switches */}
      {!showTimestamp && i > 0 && (
        <div className={messages[i - 1].role !== msg.role ? "h-[var(--space-4)]" : "h-[var(--space-1)]"} />
      )}

      {/* Notification message — centered system-style banner */}
      {isNotification && (
        <div className="flex justify-center px-[var(--space-4)] mb-[var(--space-1)]">
          <div className="notification-msg-bubble flex items-start gap-[var(--space-2)] py-[var(--space-3)] px-[var(--space-4)] rounded-[var(--radius-md)] bg-[var(--fill-secondary)] text-[var(--text-secondary)] text-[length:var(--text-caption1)] leading-[var(--leading-relaxed)] max-w-[85%]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5 opacity-60">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            <span>{formattedContent}</span>
          </div>
        </div>
      )}

      {/* User message */}
      {isUser && (
        <div className="flex flex-col items-end px-[var(--space-3)] lg:px-[var(--space-8)]">
          {textContent && (
            <div className="user-msg-bubble py-[var(--space-3)] px-[var(--space-4)] rounded-[var(--radius-lg)_var(--radius-lg)_var(--radius-sm)_var(--radius-lg)] bg-[var(--accent-fill)] text-[var(--text-primary)] text-[length:var(--text-subheadline)] leading-[var(--leading-relaxed)] font-[var(--weight-medium)] shadow-[var(--shadow-subtle)]">
              <CollapsibleUserText>{formattedContent}</CollapsibleUserText>
            </div>
          )}
          {media.length > 0 && (
            <div className="user-msg-bubble">
              <MessageMedia media={media} isUser={true} />
            </div>
          )}
        </div>
      )}

      {/* Assistant message */}
      {!isUser && !isNotification && (
        <div className="assistant-msg-row flex min-w-0 justify-start mb-[var(--space-1)]">
          <div className="assistant-msg-bubble flex min-w-0 flex-col">
            {/* Text bubble */}
            {textContent && (
              <div className="assistant-transcript py-[var(--space-1)] text-[var(--text-primary)] text-[length:var(--text-body)] leading-[var(--leading-relaxed)]">
                {formattedContent}
              </div>
            )}

            {blocks.length > 0 && (
              <div className="mt-1.5 flex min-w-0 max-w-full flex-col items-start gap-1.5">
                {blocks.map((block) => (
                  <ChatBlockInline
                    key={block.id}
                    block={block}
                  />
                ))}
              </div>
            )}

            {/* Media attachments */}
            {media.length > 0 && <MessageMedia media={media} isUser={false} />}

            {/* Subtle action row — copy + retry (no avatars, full-width preserved) */}
            {textContent && (
              <MessageActions
                id={msg.id || `idx-${i}`}
                text={textContent}
                onRetry={onRetry && prevUserText ? () => onRetry(prevUserText) : undefined}
                retryDisabled={loading}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
})
