import { useState, useRef, useCallback, useEffect } from "react"
import { api } from "@/lib/api"

type AudioSessionType =
  | "auto"
  | "playback"
  | "transient"
  | "transient-solo"
  | "ambient"
  | "play-and-record"

interface AudioSessionLike {
  type: AudioSessionType
}

interface NavigatorWithAudioSession extends Navigator {
  audioSession?: AudioSessionLike
}

export type SttState =
  | "idle"           // mic not active
  | "no-model"       // model not downloaded, need to show download modal
  | "recording"      // actively recording
  | "transcribing"   // audio sent, waiting for result
  | "error"          // transcription failed

export interface UseSttReturn {
  state: SttState
  available: boolean | null
  downloadProgress: number | null
  analyser: AnalyserNode | null
  /** Configured languages from the gateway */
  languages: string[]
  /** Currently selected language for transcription */
  selectedLanguage: string
  /** Error message when state is "error" */
  error: string | null
  /** Cycle to the next language */
  cycleLanguage: () => void
  handleMicClick: () => void
  startRecording: () => Promise<void>
  stopRecording: () => Promise<string | null>
  cancelRecording: () => void
  startDownload: () => void
  dismissDownload: () => void
  dismissError: () => void
}

const MAX_RECORDING_MS = 30 * 60_000 // 30 minutes max

function setAudioSessionType(type: AudioSessionType): AudioSessionLike | null {
  if (typeof navigator === "undefined") return null
  const audioSession = (navigator as NavigatorWithAudioSession).audioSession
  if (!audioSession) return null
  try {
    audioSession.type = type
    return audioSession
  } catch {
    return null
  }
}

function releaseCaptureAudioSession() {
  const audioSession = setAudioSessionType("ambient")
  if (!audioSession) return
  queueMicrotask(() => {
    try {
      audioSession.type = "auto"
    } catch {
      /* noop */
    }
  })
}

function createAudioContext(): AudioContext {
  const Ctor: typeof AudioContext =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  return new Ctor()
}

export function useStt(
  wsEvents?: Array<{ event: string; payload: unknown }>,
  onAutoTranscript?: (text: string) => void,
): UseSttReturn {
  const [state, setState] = useState<SttState>("idle")
  const [available, setAvailable] = useState<boolean | null>(null)
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null)
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)
  const [languages, setLanguages] = useState<string[]>(["en"])
  const [error, setError] = useState<string | null>(null)
  const [selectedLanguage, setSelectedLanguage] = useState<string>(() => {
    if (typeof window === "undefined") return "en"
    return localStorage.getItem("stt-language") || "en"
  })

  const selectedLanguageRef = useRef(selectedLanguage)
  selectedLanguageRef.current = selectedLanguage

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Resolve function for the stop promise — allows timeout to also trigger transcription
  const stopResolveRef = useRef<((text: string | null) => void) | null>(null)
  const mountedRef = useRef(true)
  const onAutoTranscriptRef = useRef(onAutoTranscript)
  onAutoTranscriptRef.current = onAutoTranscript

  // Process WebSocket events for download progress
  useEffect(() => {
    if (!wsEvents || wsEvents.length === 0) return
    const latest = wsEvents[wsEvents.length - 1]
    if (!latest.event.startsWith("stt:")) return

    const p = latest.payload as Record<string, unknown>
    if (latest.event === "stt:download:progress") {
      setDownloadProgress(Number(p.progress) || 0)
    }
    if (latest.event === "stt:download:complete") {
      setDownloadProgress(null)
      setAvailable(true)
      setState("idle")
    }
    if (latest.event === "stt:download:error") {
      setDownloadProgress(null)
      setState("idle")
    }
  }, [wsEvents])

  const cleanup = useCallback((opts?: { updateAnalyser?: boolean }) => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    const audioContext = audioContextRef.current
    let closePromise: Promise<void> | null = null
    if (audioContext && audioContext.state !== "closed") {
      closePromise = audioContext.close().catch(() => {})
    }
    audioContextRef.current = null
    if (opts?.updateAnalyser !== false && mountedRef.current) setAnalyser(null)
    mediaRecorderRef.current = null
    if (closePromise) {
      void closePromise.finally(releaseCaptureAudioSession)
    } else {
      releaseCaptureAudioSession()
    }
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      mountedRef.current = false
      const recorder = mediaRecorderRef.current
      if (recorder) {
        recorder.ondataavailable = null
        recorder.onstop = null
        if (recorder.state === "recording") {
          try { recorder.stop() } catch { /* noop */ }
        }
      }
      cleanup({ updateAnalyser: false })
      chunksRef.current = []
      stopResolveRef.current?.(null)
      stopResolveRef.current = null
    }
  }, [cleanup])

  const checkStatus = useCallback(async () => {
    try {
      const status = await api.sttStatus()
      setAvailable(status.available)
      if (status.downloading) {
        setDownloadProgress(status.progress)
      }
      if (status.languages?.length > 0) {
        setLanguages(status.languages)
        // If the stored language isn't in the configured list, reset to the first
        setSelectedLanguage((prev) => {
          if (!status.languages.includes(prev)) {
            const fallback = status.languages[0]
            localStorage.setItem("stt-language", fallback)
            return fallback
          }
          return prev
        })
      }
      return status.available
    } catch {
      setAvailable(false)
      return false
    }
  }, [])

  const startRecordingInner = useCallback(async () => {
    try {
      setAudioSessionType("play-and-record")
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const audioCtx = createAudioContext()
      audioContextRef.current = audioCtx
      const source = audioCtx.createMediaStreamSource(stream)
      const analyserNode = audioCtx.createAnalyser()
      analyserNode.fftSize = 128
      source.connect(analyserNode)
      setAnalyser(analyserNode)

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : ""
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      mediaRecorderRef.current = recorder
      chunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      // Attach onstop at creation time so it fires whether stopped
      // by user click, timeout, or any other reason
      recorder.onstop = async () => {
        cleanup()
        if (!mountedRef.current) {
          chunksRef.current = []
          stopResolveRef.current?.(null)
          stopResolveRef.current = null
          return
        }
        setState("transcribing")

        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        })
        chunksRef.current = []

        if (blob.size === 0) {
          setState("idle")
          stopResolveRef.current?.(null)
          stopResolveRef.current = null
          return
        }

        try {
          const result = await api.sttTranscribe(blob, selectedLanguageRef.current)
          const text = result.text || null
          setState("idle")
          setError(null)
          if (stopResolveRef.current) {
            stopResolveRef.current(text)
            stopResolveRef.current = null
          } else if (text && onAutoTranscriptRef.current) {
            // Timeout-triggered stop — no stopRecording() was called
            onAutoTranscriptRef.current(text)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Transcription failed"
          setError(msg)
          setState("error")
          if (stopResolveRef.current) {
            stopResolveRef.current(null)
            stopResolveRef.current = null
          }
        }
      }

      recorder.start(5000)
      setState("recording")

      // Auto-stop after max duration (will trigger onstop → transcription)
      timeoutRef.current = setTimeout(() => {
        if (mediaRecorderRef.current?.state === "recording") {
          mediaRecorderRef.current.stop()
        }
      }, MAX_RECORDING_MS)
    } catch {
      cleanup()
      setState("idle")
    }
  }, [cleanup])

  const handleMicClick = useCallback(async () => {
    if (state === "recording" || state === "transcribing") return
    if (state === "error") { setError(null); setState("idle") }

    const isAvailable = await checkStatus()
    if (isAvailable) {
      await startRecordingInner()
    } else {
      setState("no-model")
    }
  }, [state, checkStatus, startRecordingInner])

  const startRecording = useCallback(async () => {
    await startRecordingInner()
  }, [startRecordingInner])

  const stopRecording = useCallback(async (): Promise<string | null> => {
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state === "inactive") {
      setState("idle")
      return null
    }

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }

    return new Promise((resolve) => {
      // The onstop handler was attached in startRecordingInner.
      // It will call stopResolveRef when transcription is done.
      stopResolveRef.current = resolve

      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.stop()
      } else {
        cleanup()
        setState("idle")
        stopResolveRef.current = null
        resolve(null)
      }
    })
  }, [cleanup])

  const cancelRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (recorder) {
      recorder.ondataavailable = null
      recorder.onstop = null
      if (recorder.state === "recording") {
        try { recorder.stop() } catch { /* noop */ }
      }
    }
    cleanup()
    chunksRef.current = []
    stopResolveRef.current?.(null)
    stopResolveRef.current = null
    setState("idle")
  }, [cleanup])

  const startDownload = useCallback(() => {
    setDownloadProgress(0)
    api.sttDownload().catch(() => {
      setDownloadProgress(null)
    })
  }, [])

  const dismissDownload = useCallback(() => {
    setState("idle")
    setDownloadProgress(null)
  }, [])

  const dismissError = useCallback(() => {
    setState("idle")
    setError(null)
  }, [])

  const cycleLanguage = useCallback(() => {
    setSelectedLanguage((prev) => {
      const idx = languages.indexOf(prev)
      const next = languages[(idx + 1) % languages.length]
      localStorage.setItem("stt-language", next)
      return next
    })
  }, [languages])

  return {
    state,
    available,
    downloadProgress,
    analyser,
    languages,
    selectedLanguage,
    error,
    cycleLanguage,
    handleMicClick,
    startRecording,
    stopRecording,
    cancelRecording,
    startDownload,
    dismissDownload,
    dismissError,
  }
}
