export function ChatMessagesStyles() {
  return (
    <style>{`
      @keyframes cuttlefish-pulse {
        0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
        40% { opacity: 1; transform: scale(1); }
      }
      .assistant-msg-bubble { max-width: 100%; overflow-wrap: break-word; word-break: break-word; }
      .user-msg-bubble { max-width: 90%; overflow-wrap: break-word; word-break: break-word; }
      .notification-msg-bubble { overflow-wrap: break-word; word-break: break-word; white-space: pre-wrap; }
      .assistant-msg-row { padding: 0 var(--space-3) !important; }
      @media (min-width: 1024px) {
        .assistant-msg-bubble { max-width: 100%; }
        .user-msg-bubble { max-width: 82%; }
        .assistant-msg-row { padding: 0 var(--space-8) !important; }
      }
      /* Streaming caret — CSS-only, theme-aware via currentColor. */
      .stream-caret {
        display: inline-block;
        width: 0.5em;
        height: 1em;
        margin-left: 1px;
        vertical-align: text-bottom;
        background: currentColor;
        border-radius: 1px;
        opacity: 0.55;
        animation: cuttlefish-caret 1.05s steps(1) infinite;
      }
      @keyframes cuttlefish-caret { 0%, 50% { opacity: 0.55; } 50.01%, 100% { opacity: 0; } }
      /* Message actions — always visible by default (touch). On hover-capable
         pointers, hide at rest and reveal on row hover/focus. No !important. */
      .msg-actions { opacity: 1; transition: opacity 150ms ease; }
      @media (hover: hover) {
        .assistant-msg-row .msg-actions { opacity: 0; }
        .assistant-msg-row:hover .msg-actions,
        .assistant-msg-row:focus-within .msg-actions { opacity: 1; }
      }
      @media (hover: none) {
        .msg-actions button { min-height: 36px; min-width: 36px; }
      }
    `}</style>
  )
}
