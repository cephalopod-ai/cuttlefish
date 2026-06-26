#!/usr/bin/env python3
"""Cuttlefish Talk — Kokoro-82M TTS sidecar (Phase 2 voice loop).

A tiny long-running HTTP server (stdlib only) that wraps `kokoro-onnx`.
Mirrors the STT model-dir convention: weights live next to this process in
the Kokoro model dir. The parent (kokoro.ts) spawns this with the venv python,
health-polls /health, and POSTs /synth to get WAV bytes back.

Endpoints:
  GET  /health            -> 200 {"ok": true, "ready": <model loaded?>}
  POST /synth  {text, voice?, speed?, lang?}
                          -> 200 audio/wav  (16-bit PCM mono @ 24000 Hz)
                          -> 4xx/5xx application/json {"error": "..."}

The model loads lazily on the first /synth so /health responds instantly while
weights warm up. A single line "KOKORO_SIDECAR_LISTENING port=<p>" is printed to
stdout once the socket is bound so the parent can detect readiness.

Model/voices files are resolved from the model dir (argv/env):
  --model-dir <dir>  or  KOKORO_MODEL_DIR
  --port <p>         or  KOKORO_PORT   (default 8765)
Files expected in the model dir: kokoro-v1.0.onnx  +  voices-v1.0.bin
(falls back to any kokoro-v*.onnx / voices-v*.bin present).
"""

from __future__ import annotations

import argparse
import array
import glob
import io
import json
import os
import sys
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# kokoro-onnx is imported lazily inside the loader so /health works even if the
# heavy onnxruntime import is slow.

DEFAULT_VOICE = "af_heart"
SAMPLE_RATE = 24000  # Kokoro's native rate.

_model = None
_model_lock = threading.Lock()
_model_dir = ""
_default_voice = DEFAULT_VOICE


def _resolve_file(model_dir: str, preferred: str, pattern: str) -> str | None:
    """Return the preferred file if present, else the first glob match, else None."""
    exact = os.path.join(model_dir, preferred)
    if os.path.isfile(exact):
        return exact
    matches = sorted(glob.glob(os.path.join(model_dir, pattern)))
    return matches[0] if matches else None


def _load_model():
    """Lazy-load the Kokoro model; raises on missing weights or import errors."""
    global _model
    if _model is not None:
        return _model
    with _model_lock:
        if _model is not None:
            return _model
        onnx_path = _resolve_file(_model_dir, "kokoro-v1.0.onnx", "kokoro-v*.onnx")
        voices_path = _resolve_file(_model_dir, "voices-v1.0.bin", "voices-v*.bin")
        if not onnx_path or not voices_path:
            raise FileNotFoundError(
                f"Kokoro weights missing in {_model_dir} "
                f"(onnx={onnx_path}, voices={voices_path})"
            )
        from kokoro_onnx import Kokoro  # heavy import, deferred

        _model = Kokoro(onnx_path, voices_path)
        return _model


def _iter_pcm_samples(samples):
    """Yield scalar samples from lists/tuples/numpy-like arrays without importing numpy."""
    if hasattr(samples, "tolist"):
        samples = samples.tolist()
    if isinstance(samples, (list, tuple)):
        for item in samples:
            yield from _iter_pcm_samples(item)
        return
    yield float(samples)


def _pcm_wav_bytes(samples, sample_rate: int) -> bytes:
    """Encode float [-1,1] mono samples as a 16-bit PCM WAV (RIFF) byte string."""
    pcm = array.array("h")
    for sample in _iter_pcm_samples(samples):
        clamped = max(-1.0, min(1.0, sample))
        pcm.append(int(clamped * 32767.0))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()


def _synth(text: str, voice: str, speed: float, lang: str) -> bytes:
    model = _load_model()
    samples, sr = model.create(text, voice=voice, speed=speed, lang=lang)
    return _pcm_wav_bytes(samples, sr or SAMPLE_RATE)


class Handler(BaseHTTPRequestHandler):
    # Silence default per-request stderr logging (parent captures stdout).
    def log_message(self, *_args):  # noqa: D401
        pass

    def _json(self, status: int, obj: dict) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?")[0] == "/health":
            self._json(200, {"ok": True, "ready": _model is not None})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?")[0] != "/synth":
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            req = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception as exc:  # malformed body
            self._json(400, {"error": f"bad request: {exc}"})
            return

        text = (req.get("text") or "").strip()
        if not text:
            self._json(400, {"error": "missing 'text'"})
            return
        voice = req.get("voice") or _default_voice
        speed = float(req.get("speed") or 1.0)
        lang = req.get("lang") or "en-us"

        try:
            wav = _synth(text, voice, speed, lang)
        except FileNotFoundError as exc:
            print(f"kokoro: model not found: {exc}", file=sys.stderr, flush=True)
            self._json(503, {"error": "model_missing"})
            return
        except Exception as exc:  # synthesis failure
            print(f"kokoro: synthesis failed: {exc}", file=sys.stderr, flush=True)
            self._json(500, {"error": "synthesis_failed"})
            return

        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
        self.end_headers()
        self.wfile.write(wav)


def main() -> int:
    global _default_voice, _model_dir
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=os.environ.get("KOKORO_PORT", "8765"))
    parser.add_argument("--model-dir", default=os.environ.get("KOKORO_MODEL_DIR", os.getcwd()))
    parser.add_argument("--voice", default=os.environ.get("KOKORO_VOICE", DEFAULT_VOICE))
    parser.add_argument("--warm", action="store_true", help="load the model before serving")
    args = parser.parse_args()

    _model_dir = os.path.abspath(args.model_dir)
    _default_voice = args.voice
    if not os.path.isdir(_model_dir):
        print("KOKORO_SIDECAR_MODEL_DIR_MISSING", flush=True)
        return 1

    if args.warm:
        try:
            _load_model()
        except Exception as exc:  # report but still serve so /health is reachable
            print("KOKORO_SIDECAR_WARM_FAILED", flush=True)
            print(f"kokoro warm-load detail: {exc}", file=sys.stderr, flush=True)

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    # Print AFTER bind so the parent only sees this once the socket accepts.
    print(f"KOKORO_SIDECAR_LISTENING port={args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
