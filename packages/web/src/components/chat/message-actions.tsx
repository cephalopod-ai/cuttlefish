import { useState } from "react"
import { useMessageTts } from "./use-message-tts"

const ACTION_BTN =
  "inline-flex h-[26px] w-[26px] items-center justify-center rounded-[7px] border-none bg-transparent text-[var(--text-quaternary)] transition-colors hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)] cursor-pointer disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--text-quaternary)]"

export function MessageActions({ id, text, onRetry, retryDisabled }: { id: string; text: string; onRetry?: () => void; retryDisabled?: boolean }) {
  const [copied, setCopied] = useState(false)
  const tts = useMessageTts(id, text)
  const speaking = tts.phase === "playing"
  const loading = tts.phase === "loading"

  function handleCopy() {
    if (!text) return
    navigator.clipboard.writeText(text)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400) })
      .catch(() => {})
  }

  return (
    <div className="msg-actions mt-0.5 -ml-1 flex items-center gap-0.5">
      <button onClick={handleCopy} aria-label={copied ? "Copied" : "Copy message"} title={copied ? "Copied" : "Copy"} className={ACTION_BTN}>
        {copied ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
      {/* Read aloud — toggles play↔pause. Custom (Kokoro) TTS with a browser
          Web Speech fallback; only one message speaks at a time. */}
      <button
        onClick={tts.toggle}
        aria-label={speaking ? "Pause" : loading ? "Loading audio" : "Read aloud"}
        aria-pressed={speaking || loading}
        title={speaking ? "Pause" : "Read aloud"}
        className={ACTION_BTN}
      >
        {loading ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        ) : speaking ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="6" y="4" width="4" height="16" rx="1" />
            <rect x="14" y="4" width="4" height="16" rx="1" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="6 3 20 12 6 21 6 3" />
          </svg>
        )}
      </button>
      {onRetry && (
        <button onClick={onRetry} disabled={retryDisabled} aria-label="Retry" title="Resend the previous message" className={ACTION_BTN}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 4v6h6M23 20v-6h-6" />
            <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />
          </svg>
        </button>
      )}
    </div>
  )
}
