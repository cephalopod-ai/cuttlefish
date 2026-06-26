import { describe, expect, it } from 'vitest'
import { classifyMicGesture, MIC_HOLD_THRESHOLD_MS } from '../chat-input'
import { waveformBarHeight, scaleForDpr } from '../mic-waveform'

describe('classifyMicGesture', () => {
  it('treats a press at or beyond the threshold as a hold (push-to-talk)', () => {
    expect(classifyMicGesture(1000, 1000 + MIC_HOLD_THRESHOLD_MS)).toBe('hold')
    expect(classifyMicGesture(1000, 1000 + MIC_HOLD_THRESHOLD_MS + 500)).toBe('hold')
  })

  it('treats a press shorter than the threshold as a quick tap (toggle)', () => {
    expect(classifyMicGesture(1000, 1000 + MIC_HOLD_THRESHOLD_MS - 1)).toBe('tap')
    expect(classifyMicGesture(1000, 1010)).toBe('tap')
    expect(classifyMicGesture(1000, 1000)).toBe('tap')
  })

  it('honors a custom threshold', () => {
    expect(classifyMicGesture(0, 100, 50)).toBe('hold')
    expect(classifyMicGesture(0, 40, 50)).toBe('tap')
  })
})

describe('waveformBarHeight', () => {
  it('clamps to the minimum bar height for silence', () => {
    expect(waveformBarHeight(0, 16, 2)).toBe(2)
    expect(waveformBarHeight(-1, 16, 2)).toBe(2)
  })

  it('scales linearly with the audio level', () => {
    expect(waveformBarHeight(0.5, 16, 2)).toBe(8)
    expect(waveformBarHeight(1, 16, 2)).toBe(16)
  })

  it('clamps levels above 1 to the full height', () => {
    expect(waveformBarHeight(2, 16, 2)).toBe(16)
  })
})

describe('scaleForDpr', () => {
  it('multiplies the backing store by the device pixel ratio', () => {
    expect(scaleForDpr(20, 16, 2)).toEqual({ width: 40, height: 32 })
    expect(scaleForDpr(20, 16, 1)).toEqual({ width: 20, height: 16 })
  })

  it('rounds fractional ratios and falls back to 1 for invalid values', () => {
    expect(scaleForDpr(20, 16, 1.5)).toEqual({ width: 30, height: 24 })
    expect(scaleForDpr(20, 16, 0)).toEqual({ width: 20, height: 16 })
  })
})
