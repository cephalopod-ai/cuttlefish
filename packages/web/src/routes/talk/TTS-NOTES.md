# Cuttlefish Talk — TTS strategy (Concept AURA)

`use-speak.ts` ships a thin, promise-based `SpeakHandle` over the browser **Web
Speech API**. It works today with zero infra. This doc explains why, and the
path to a local OSS voice for production quality.

## Option comparison

| | **Web Speech API** | **Piper** | **Kokoro-82M** |
|---|---|---|---|
| Infra | None — runs in the browser | Server / edge (ONNX Runtime) | Server / GPU-ish (ONNX or PyTorch) |
| Latency | Instant (local OS engine) | Very low (real-time on CPU) | Low–moderate (heavier than Piper) |
| Size | 0 (OS-provided) | Tiny (~20–60 MB per voice) | ~82M params (~300 MB) |
| Quality | Varies wildly by OS/browser; "Natural"/"Premium" voices are good, defaults can be robotic | Clear but flatter/robotic prosody | Near-natural, best quality-per-size |
| Voice control | Limited; voice list is whatever the OS ships | Per-voice models, deterministic | Multiple expressive voices |
| Offline | Yes | Yes | Yes |
| Licence | Platform | MIT | Apache-2.0 |
| Word timing | `onboundary` events (built-in) | Phoneme/word timestamps available | Alignment available, slightly more work |

## Recommendation

**Web Speech now → Kokoro-82M for production quality, Piper as the
low-latency / edge fallback.**

- **Now:** Web Speech is the only zero-infra option, so the POC never blocks on
  a backend. Quality is acceptable on machines with a good "Natural"/"Enhanced"
  voice (the hook's `pickVoice` heuristic targets exactly those), and it gives
  us word boundaries for free to sync the transcript reveal.
- **Production:** Kokoro-82M is the sweet spot — near-natural output at a tiny
  82M-param footprint, Apache-2.0, fully self-hostable. It's the voice users
  should hear by default.
- **Fallback / edge:** Piper when latency or CPU budget is tight (real-time on a
  modest CPU, tiny models). Feature-flag it as the fast tier; Web Speech remains
  the no-server safety net.

## Integration architecture (so swapping is trivial)

`use-speak.ts` is deliberately shaped so the backend is a drop-in swap: any
backend just has to satisfy the same `SpeakHandle` (promise-based `speak()`,
`cancel()`, `speaking`, `supported`) and emit the same per-word `onWord` events.

```ts
// Backend-agnostic adapter — Web Speech, Piper, and Kokoro all implement this.
interface WordMark { charIndex: number; word: string; timeMs: number }

interface TtsAdapter {
  synthesize(
    text: string,
    opts?: { rate?: number; pitch?: number },
  ): Promise<{ audio: Blob | ArrayBuffer; marks?: WordMark[] }>
}
```

Flow for the local-OSS tier:

1. **Gateway endpoint** — `POST /api/tts` accepts `{ text, rate, pitch }`,
   streams audio back (e.g. `audio/wav` or `audio/mpeg`), with the active model
   chosen behind an env flag (`TTS_MODEL=kokoro|piper`).
2. **Client adapter** implements `TtsAdapter.synthesize`, calling `/api/tts` and
   returning the audio plus `marks` (word timestamps from the model alignment).
3. **Playback** — the audio plays via an `<audio>` element / Web Audio node
   instead of `SpeechSynthesisUtterance`.
4. **Word sync** — a small scheduler fires `marks` at their `timeMs` against the
   audio's `currentTime`, driving the **same `onWord` callback** this hook
   already exposes. The transcript-reveal UI never changes.
5. **`supported`** stays meaningful: true once the adapter/endpoint is
   reachable; otherwise the hook falls back to Web Speech, then to the
   estimated-duration timer so the scripted demo always advances.

Because the React surface (`SpeakHandle`) is identical across backends, swapping
Web Speech → Kokoro is internal to the hook — no consumer changes.

## Next steps (wire local Kokoro / Piper)

- **Download the model** — fetch Kokoro-82M (and a Piper voice) ONNX weights at
  build/first-run; cache under the gateway's model dir, mirroring the STT
  download-modal pattern already in the app.
- **Server route** — add `POST /api/tts` running ONNX Runtime, `TTS_MODEL` env
  flag selecting Kokoro (default) or Piper, returning streamed audio + word marks.
- **Stream + play** — implement the `TtsAdapter`, play streamed chunks via Web
  Audio for low time-to-first-audio.
- **Sync word marks** — schedule model word timestamps against audio
  `currentTime` to fire the existing `onWord` callback.
- **Feature-flag fallback** — if `/api/tts` is unreachable or the model isn't
  downloaded, fall back to Web Speech, then to the estimated-duration timer.
