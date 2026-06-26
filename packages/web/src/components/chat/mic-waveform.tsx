import React, { useRef, useEffect } from "react"

/**
 * Pure helper: map a normalized audio level (0..1) to a bar pixel height,
 * clamped to a minimum so silent bars still read as a row of dots.
 * Exported for unit testing.
 */
export function waveformBarHeight(value01: number, height: number, minBar = 2): number {
  const clamped = Math.max(0, Math.min(1, value01))
  return Math.max(minBar, clamped * height)
}

/**
 * Pure helper: compute the backing-store size for a DPR-scaled canvas.
 * Exported for unit testing.
 */
export function scaleForDpr(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): { width: number; height: number } {
  const ratio = dpr > 0 ? dpr : 1
  return {
    width: Math.round(cssWidth * ratio),
    height: Math.round(cssHeight * ratio),
  }
}

interface MicWaveformProps {
  analyser: AnalyserNode
  /** CSS width in px (the visible footprint). */
  cssWidth?: number
  /** CSS height in px. */
  cssHeight?: number
  /** Number of bars to draw. */
  barCount?: number
}

/**
 * Compact, crisp waveform that lives INSIDE the mic button while recording.
 * DPR-scaled canvas + requestAnimationFrame reading the live AnalyserNode.
 * Inherits its color from the button's text color (currentColor) so it stays
 * theme-correct without hardcoded values.
 */
export function MicWaveform({
  analyser,
  cssWidth = 20,
  cssHeight = 16,
  barCount = 4,
}: MicWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !analyser) return

    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1
    const { width: bw, height: bh } = scaleForDpr(cssWidth, cssHeight, dpr)
    canvas.width = bw
    canvas.height = bh
    ctx.scale(dpr, dpr)

    const bufferLength = analyser.frequencyBinCount
    const dataArray = new Uint8Array(bufferLength)
    const barGap = 2
    const barWidth = (cssWidth - barGap * (barCount - 1)) / barCount
    const radius = Math.min(barWidth / 2, 2)

    function draw() {
      rafRef.current = requestAnimationFrame(draw)
      analyser.getByteFrequencyData(dataArray)

      ctx!.clearRect(0, 0, cssWidth, cssHeight)
      ctx!.fillStyle = getComputedStyle(canvas!).color || "currentColor"

      for (let i = 0; i < barCount; i++) {
        // Spread samples across the lower 60% of the spectrum (where voice sits).
        const dataIndex = Math.floor((i / barCount) * (bufferLength * 0.6))
        const value = dataArray[dataIndex] / 255
        const barHeight = waveformBarHeight(value, cssHeight)
        const x = i * (barWidth + barGap)
        const y = (cssHeight - barHeight) / 2
        ctx!.beginPath()
        ctx!.roundRect(x, y, barWidth, barHeight, radius)
        ctx!.fill()
      }
    }

    draw()

    return () => {
      cancelAnimationFrame(rafRef.current)
    }
  }, [analyser, cssWidth, cssHeight, barCount])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      style={{ width: cssWidth, height: cssHeight, display: "block" }}
    />
  )
}
