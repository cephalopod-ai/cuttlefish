import { describe, it, expect } from 'vitest'
import {
  isFilePath,
  parseFenceLang,
  shouldCollapse,
  USER_COLLAPSE_PX,
  USER_COLLAPSE_SLACK,
} from '../chat-messages'

// Pins the file-path detection behaviour so the shared FILE_PATH_CORE regex
// (used both for isFilePath and the inline-formatter's bare-path alternative)
// cannot silently drift. Rule: optional ~/ or / prefix, ≥1 slash-separated
// segment, ending in a short extension.
describe('isFilePath', () => {
  const shouldLink = [
    'docs/superpowers/specs/2026-05-31-support-design.md',
    '~/Projects/cuttlefish/packages/web/src/main.tsx',
    '/etc/hosts.conf',
    'skills/foo/SKILL.md',
  ]

  const shouldNotLink = [
    'text/markdown',             // mime type: slash but no extension
    'feat/clickable-file-paths', // branch name: slash but no extension
    '0.16.1',                    // version number: no slash
    'v0.16.1',                   // version number: no slash
    'and/or',                    // prose: slash but no extension
    'config.yaml',               // bare filename: extension but NO slash (slash is required)
    'https://example.com/x.md',  // URL: handled by the URL branch, not the path branch
  ]

  it.each(shouldLink)('treats %s as a file path', (s) => {
    expect(isFilePath(s)).toBe(true)
  })

  it.each(shouldNotLink)('does NOT treat %s as a file path', (s) => {
    expect(isFilePath(s)).toBe(false)
  })
})

// Pins the code-fence language parsing used to label code blocks. Rule: take the
// first whitespace-delimited token after the ``` marker, lowercased; '' for bare.
describe('parseFenceLang', () => {
  it('extracts a simple language tag', () => {
    expect(parseFenceLang('```ts')).toBe('ts')
    expect(parseFenceLang('```TSX')).toBe('tsx')
  })
  it('returns the first token when extra fence metadata follows', () => {
    expect(parseFenceLang('```js {3-5} title="x"')).toBe('js')
  })
  it('returns empty string for a bare fence', () => {
    expect(parseFenceLang('```')).toBe('')
    expect(parseFenceLang('```   ')).toBe('')
  })
})

// Pins the auto-collapse decision for long user messages. A bubble only
// collapses once its rendered height clears the threshold PLUS a slack margin,
// so the "Show more" control never appears just to hide a clipped sliver.
describe('shouldCollapse', () => {
  it('does not collapse short messages', () => {
    expect(shouldCollapse(40)).toBe(false)
    expect(shouldCollapse(USER_COLLAPSE_PX)).toBe(false)
  })

  it('does not collapse when only a sliver exceeds the threshold (within slack)', () => {
    expect(shouldCollapse(USER_COLLAPSE_PX + USER_COLLAPSE_SLACK)).toBe(false)
    expect(shouldCollapse(USER_COLLAPSE_PX + 1)).toBe(false)
  })

  it('collapses once meaningfully past the threshold + slack', () => {
    expect(shouldCollapse(USER_COLLAPSE_PX + USER_COLLAPSE_SLACK + 1)).toBe(true)
    expect(shouldCollapse(900)).toBe(true)
  })

  it('honours custom threshold/slack overrides', () => {
    expect(shouldCollapse(120, 100, 10)).toBe(true)
    expect(shouldCollapse(105, 100, 10)).toBe(false)
  })
})
