/**
 * Returns the URL only if it is safe to place in an <a href> / <img src>, else
 * null. Blocks script-capable schemes (javascript:, vbscript:, data:, file:) —
 * which would execute in the dashboard origin (= local-gateway privilege
 * escalation) when fed attacker-influenced values (media URLs, agent output,
 * archived content). Relative paths (e.g. /api/files/...), http(s), mailto and
 * blob: are all allowed: they cannot execute script.
 */
const DANGEROUS_SCHEME = /^(javascript|vbscript|data|file):/

export function safeHttpUrl(url: string | undefined | null): string | null {
  if (typeof url !== "string") return null
  const trimmed = url.trim()
  if (!trimmed) return null
  // Browsers ignore whitespace/control chars *inside* a scheme ("java\tscript:"),
  // so strip them before classifying to prevent that bypass.
  const normalized = trimmed.replace(/[\u0000-\u0020]+/g, "").toLowerCase()
  if (DANGEROUS_SCHEME.test(normalized)) return null
  return trimmed
}

/**
 * Returns true for URLs that will cause the browser to issue an outbound
 * network request to a third-party host — i.e. absolute http(s) URLs.
 * Relative paths (/api/files/...) and blob: URLs resolve to the same origin
 * and are NOT considered remote.
 *
 * Used to gate click-to-load for assistant-supplied media so that a model
 * cannot silently exfiltrate data via an auto-fetched tracking pixel embedded
 * in model output.
 */
export function isRemoteUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim())
}
