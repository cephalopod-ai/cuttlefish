import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const sttStatus = vi.fn()
const sttTranscribe = vi.fn()
const sttDownload = vi.fn()

vi.mock("@/lib/api", () => ({
  api: {
    sttStatus: () => sttStatus(),
    sttTranscribe: (blob: Blob, language: string) => sttTranscribe(blob, language),
    sttDownload: () => sttDownload(),
  },
}))

import { useStt } from "../use-stt"

class FakeAudioContext {
  state: AudioContextState = "running"
  close = vi.fn(async () => {
    this.state = "closed"
  })
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }))
  createAnalyser = vi.fn(() => ({
    fftSize: 0,
  }))
}

class FakeMediaRecorder {
  static isTypeSupported = vi.fn((type: string) => type === "audio/webm;codecs=opus")

  state: RecordingState = "inactive"
  mimeType = "audio/webm;codecs=opus"
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onstop: ((event: Event) => void) | null = null

  constructor(
    _stream: MediaStream,
    opts?: MediaRecorderOptions,
  ) {
    if (opts?.mimeType) this.mimeType = opts.mimeType
  }

  start() {
    this.state = "recording"
  }

  stop() {
    this.state = "inactive"
    this.ondataavailable?.({ data: new Blob(["voice"], { type: this.mimeType }) } as BlobEvent)
    this.onstop?.(new Event("stop"))
  }
}

function installMediaMocks() {
  const track = { stop: vi.fn() }
  const stream = {
    getTracks: () => [track],
  } as unknown as MediaStream
  const getUserMedia = vi.fn().mockResolvedValue(stream)
  const audioSession = { type: "auto" }

  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia },
    configurable: true,
  })
  Object.defineProperty(navigator, "audioSession", {
    value: audioSession,
    configurable: true,
  })
  Object.defineProperty(window, "AudioContext", {
    value: FakeAudioContext,
    configurable: true,
  })
  Object.defineProperty(window, "MediaRecorder", {
    value: FakeMediaRecorder,
    configurable: true,
  })
  Object.defineProperty(globalThis, "MediaRecorder", {
    value: FakeMediaRecorder,
    configurable: true,
  })

  return { track, getUserMedia, audioSession }
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  vi.clearAllMocks()
  sttStatus.mockResolvedValue({ available: true, downloading: false, languages: ["en"] })
  sttTranscribe.mockResolvedValue({ text: "hello" })
})

describe("useStt", () => {
  it("cancels recording without transcribing captured audio", async () => {
    const { track, audioSession } = installMediaMocks()
    const { result } = renderHook(() => useStt())

    await act(async () => {
      await result.current.handleMicClick()
    })
    expect(result.current.state).toBe("recording")
    expect(audioSession.type).toBe("play-and-record")

    act(() => {
      result.current.cancelRecording()
    })
    await flushMicrotasks()

    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(sttTranscribe).not.toHaveBeenCalled()
    expect(result.current.state).toBe("idle")
    expect(audioSession.type).toBe("auto")
  })

  it("transcribes on stop and releases the iOS audio session", async () => {
    const { track, audioSession } = installMediaMocks()
    const { result } = renderHook(() => useStt())

    await act(async () => {
      await result.current.handleMicClick()
    })

    let transcript: string | null = null
    await act(async () => {
      transcript = await result.current.stopRecording()
    })
    await flushMicrotasks()

    expect(transcript).toBe("hello")
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(sttTranscribe).toHaveBeenCalledTimes(1)
    expect(sttTranscribe).toHaveBeenCalledWith(expect.any(Blob), "en")
    expect(result.current.state).toBe("idle")
    expect(audioSession.type).toBe("auto")
  })

  it("does not transcribe when the hook unmounts mid-recording", async () => {
    const { track, audioSession } = installMediaMocks()
    const { result, unmount } = renderHook(() => useStt())

    await act(async () => {
      await result.current.handleMicClick()
    })

    unmount()
    await flushMicrotasks()

    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(sttTranscribe).not.toHaveBeenCalled()
    expect(audioSession.type).toBe("auto")
  })
})
