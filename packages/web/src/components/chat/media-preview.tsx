import React from 'react'
import type { MediaAttachment } from '@/lib/conversations'

interface MediaPreviewProps {
  attachments: MediaAttachment[]
  onRemove: (index: number) => void
}

export function MediaPreview({ attachments, onRemove }: MediaPreviewProps) {
  if (attachments.length === 0) return null

  return (
    <div style={{
      display: 'flex',
      gap: 'var(--space-2)',
      padding: 'var(--space-2) var(--space-3)',
      overflowX: 'auto',
      overflowY: 'hidden',
    }}>
      {attachments.map((att, i) => (
        <div key={i} style={{
          position: 'relative',
          width: 56,
          height: 56,
          flexShrink: 0,
          borderRadius: 'var(--radius-md)',
          overflow: 'hidden',
          background: 'var(--fill-tertiary)',
        }}>
          {att.type === 'image' ? (
            <img
              src={att.url}
              alt={att.name || 'Preview'}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
              }}
            />
          ) : (
            <div style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 2,
              padding: 4,
            }}>
              {att.type === 'audio' ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 18V5l12-2v13" />
                  <circle cx="6" cy="18" r="3" />
                  <circle cx="18" cy="16" r="3" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                  <polyline points="13 2 13 9 20 9" />
                </svg>
              )}
              <span style={{
                fontSize: 8,
                color: 'var(--text-quaternary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: '100%',
                textAlign: 'center',
              }}>
                {att.name?.split('.').pop()?.toUpperCase() || att.type.toUpperCase()}
              </span>
            </div>
          )}

          {/* Remove button — ≥36px pressable target (transparent), with an 18px
              frosted token chip drawn in the top-right corner. */}
          <button
            onClick={() => onRemove(i)}
            aria-label="Remove attachment"
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              width: 36,
              height: 36,
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'flex-end',
              padding: 2,
              margin: 0,
            }}
          >
            <span style={{
              width: 18,
              height: 18,
              borderRadius: '50%',
              background: 'var(--material-thick)',
              color: 'var(--text-primary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: 'var(--shadow-subtle)',
            }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </span>
          </button>
        </div>
      ))}
    </div>
  )
}
