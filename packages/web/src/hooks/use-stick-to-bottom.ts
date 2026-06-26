import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * Stick-to-bottom for the chat thread.
 *
 * One source of truth — `followRef` — decides whether the view auto-follows new
 * content. It is flipped ONLY by the user's own scroll (a `scroll` event whose
 * distance-from-bottom exceeds the threshold means "I scrolled up to read"; back
 * within the threshold means "I caught up"). Programmatic scrolls never flip it.
 *
 * Following is performed synchronously in a layout effect (before paint) keyed on
 * the growing content, so streaming can never visually detach. Resize / mobile
 * keyboard (ResizeObserver on the *viewport*), tab return (visibilitychange /
 * pageshow) and initial mount each re-pin when — and only when — we're following.
 * When NOT following we never touch scrollTop, so the browser's native
 * `overflow-anchor` holds the read position through image/content reflow above.
 *
 * Replaces the old IntersectionObserver(position) + ResizeObserver(content)→rAF
 * design, whose two async mechanisms raced and lost the stream (the sentinel left
 * the 80px band before the queued rAF read the now-stale "at bottom" flag).
 */

/** Within this many px of the bottom counts as "at bottom" (engage follow). */
export const STICK_THRESHOLD_PX = 56

type Metrics = { scrollHeight: number; scrollTop: number; clientHeight: number }

/** Distance in px from the current scroll position to the very bottom (0 = pinned). */
export function distanceFromBottom(el: Metrics): number {
  return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight)
}

/** Whether auto-follow should be engaged for a given distance from the bottom. */
export function shouldFollow(distance: number, threshold: number = STICK_THRESHOLD_PX): boolean {
  return distance <= threshold
}

/** New messages accumulated while detached (current count − count when last caught up), ≥ 0. */
export function unreadDelta(currentCount: number, seenCount: number): number {
  return Math.max(0, currentCount - seenCount)
}

export interface UseStickToBottomOptions {
  /** Changes whenever the in-flight assistant message streams more text. */
  streamingText?: string
  /** Total committed message count — drives mount-snap, growth-follow, and the unread count. */
  messageCount: number
  /** Override the at-bottom threshold (px). */
  threshold?: number
}

export interface StickToBottom {
  /** Callback ref for the scroll container. Using a callback (not a ref object) so the
   *  listener effects re-run when the element actually mounts — the scroller appears in
   *  a later render than the hook (the empty-state branch renders first). */
  containerRef: (node: HTMLDivElement | null) => void
  /** Show the "jump to latest" affordance (user has scrolled away from the bottom). */
  showJump: boolean
  /** New messages that arrived while detached (0 when caught up). */
  unreadCount: number
  /** Scroll to the bottom and re-engage follow. Defaults to smooth (for the button). */
  scrollToBottom: (behavior?: ScrollBehavior) => void
}

export function useStickToBottom({
  streamingText,
  messageCount,
  threshold = STICK_THRESHOLD_PX,
}: UseStickToBottomOptions): StickToBottom {
  // The scroll container, tracked as state (via a callback ref) so the listener
  // effects re-run when it mounts, plus a ref mirror for imperative reads.
  const elRef = useRef<HTMLDivElement | null>(null)
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const containerRef = useCallback((node: HTMLDivElement | null) => {
    elRef.current = node
    setEl(node)
  }, [])

  const followRef = useRef(true)
  // True only while a programmatic SMOOTH scroll is animating, so its intermediate
  // (far-from-bottom) scroll events aren't mistaken for the user scrolling up.
  const animatingRef = useRef(false)
  // Count at the moment we were last caught up — the baseline for unreadDelta.
  const seenCountRef = useRef(messageCount)
  // Fresh message count for stable callbacks (avoids stale closures).
  const messageCountRef = useRef(messageCount)
  messageCountRef.current = messageCount
  const mountedRef = useRef(false)
  const uiRaf = useRef<number | null>(null)

  const [showJump, setShowJump] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)

  const pinNow = useCallback((node: HTMLDivElement) => {
    node.scrollTop = node.scrollHeight
  }, [])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const node = elRef.current
    if (!node) return
    followRef.current = true
    seenCountRef.current = messageCountRef.current
    setShowJump(false)
    setUnreadCount(0)
    if (behavior === 'smooth' && typeof node.scrollTo === 'function') {
      animatingRef.current = true
      node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' })
    } else {
      pinNow(node)
    }
  }, [pinNow])

  // ── User-intent tracking: the scroll event is the ONLY place follow flips. ──
  // Keyed on `el` so it (re)attaches when the scroller mounts in a later render.
  useEffect(() => {
    if (!el) return

    const onScroll = () => {
      const dist = distanceFromBottom(el)
      if (animatingRef.current) {
        // Our own smooth scroll is still running; only clear once it reaches bottom.
        if (dist <= threshold) animatingRef.current = false
        return
      }
      const follow = shouldFollow(dist, threshold)
      followRef.current = follow
      if (follow) seenCountRef.current = messageCountRef.current
      if (uiRaf.current != null) cancelAnimationFrame(uiRaf.current)
      uiRaf.current = requestAnimationFrame(() => {
        uiRaf.current = null
        if (follow) {
          setShowJump(false)
          setUnreadCount(0)
        } else {
          setShowJump(true)
          setUnreadCount(unreadDelta(messageCountRef.current, seenCountRef.current))
        }
      })
    }

    // A manual wheel/touch interrupts an in-flight smooth scroll → respect the user.
    const cancelAnimating = () => { animatingRef.current = false }

    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', cancelAnimating, { passive: true })
    el.addEventListener('touchstart', cancelAnimating, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', cancelAnimating)
      el.removeEventListener('touchstart', cancelAnimating)
      if (uiRaf.current != null) cancelAnimationFrame(uiRaf.current)
    }
  }, [el, threshold])

  // ── Initial load / session switch (ChatPane is keyed → this hook remounts): ──
  // snap to bottom once, synchronously, the first time messages are present.
  useLayoutEffect(() => {
    if (mountedRef.current || messageCount === 0) return
    const node = elRef.current
    if (!node) return // scroller not attached yet; re-runs when `el` is set
    mountedRef.current = true
    pinNow(node)
    followRef.current = true
    seenCountRef.current = messageCount
  }, [el, messageCount, pinNow])

  // ── Follow on growth — synchronous, before paint, so streaming never detaches. ──
  useLayoutEffect(() => {
    const node = elRef.current
    if (!node) return
    if (followRef.current) {
      pinNow(node)
      seenCountRef.current = messageCount
      if (unreadCount !== 0) setUnreadCount(0)
    } else {
      setUnreadCount(unreadDelta(messageCount, seenCountRef.current))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el, streamingText, messageCount, pinNow])

  // ── Viewport resize / mobile keyboard: re-pin when following (RO on the container). ──
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (followRef.current && elRef.current) pinNow(elRef.current)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [el, pinNow])

  // ── Tab return: re-sync (rAF is throttled in background tabs, so don't rely on it). ──
  useEffect(() => {
    const resync = () => {
      if (document.visibilityState === 'visible' && followRef.current && elRef.current) {
        pinNow(elRef.current)
      }
    }
    document.addEventListener('visibilitychange', resync)
    window.addEventListener('pageshow', resync)
    return () => {
      document.removeEventListener('visibilitychange', resync)
      window.removeEventListener('pageshow', resync)
    }
  }, [pinNow])

  return { containerRef, showJump, unreadCount, scrollToBottom }
}
