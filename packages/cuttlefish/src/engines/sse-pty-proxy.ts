import http from "node:http";
import https from "node:https";
import { StringDecoder } from "node:string_decoder";
import { logger } from "../shared/logger.js";

/** Shared keep-alive agent so concurrent turns (and sub-agent fan-out) reuse a
 *  small TLS socket pool instead of opening a fresh handshake per request — the
 *  per-request TLS churn was the likely source of intermittent "bad record mac"
 *  errors under sub-agent concurrency. */
const upstreamAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

/** Kill an upstream connection that goes silent this long (no bytes). Long enough
 *  for extended-thinking/tool gaps, while still reaping genuinely stuck sockets. */
const UPSTREAM_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_SSE_FRAME_BYTES = 2 * 1024 * 1024;

/** A parsed Anthropic SSE event's `data:` JSON payload (already JSON.parsed). */
export interface SseDataEvent {
  type?: string;
  [k: string]: unknown;
}

/** Gateway-controlled marker injected into the MAIN agent's appended system prompt.
 *  The proxy tees only requests whose system carries it — Task sub-agents get Claude
 *  Code's own system prompt (no sentinel) and are therefore suppressed. This is the
 *  one main-vs-sub signal the gateway fully owns, so it cannot drift like a request
 *  fingerprint does. It is an HTML comment so the model ignores it. */
export const MAIN_AGENT_SENTINEL = "<!-- cuttlefish-main-agent:5c1f -->";

/** Signature of `https.request`/`http.request` — the seam we inject in tests so
 *  the proxy can target a local fake upstream instead of api.anthropic.com. */
type UpstreamRequestFn = (
  options: https.RequestOptions,
  cb: (res: http.IncomingMessage) => void,
) => http.ClientRequest;

/** Snapshot of the proxy's in-flight upstream work, fired on every change. */
export interface UpstreamActivityInfo {
  activeStreams: number;
  lastActivityAt: number;
}

/** Test/override hooks. All optional; defaults reproduce production behavior
 *  (https → api.anthropic.com:443 over the shared keep-alive pool). */
export interface SsePtyProxyOpts {
  requestFn?: UpstreamRequestFn;
  upstream?: { hostname: string; port: number };
  /** Agent for the FIRST attempt. Default: the shared keep-alive pool. */
  primaryAgent?: https.Agent | http.Agent | false;
  /** Hard cap for the buffered request body forwarded to Anthropic. */
  maxRequestBodyBytes?: number;
  /** Hard cap for one parsed SSE frame; forwarding continues if tee parsing stops. */
  maxSseFrameBytes?: number;
  /** Fired whenever the in-flight upstream request count changes (start AND every
   *  terminal path: response end, upstream error, client-gone abort). Counts ALL
   *  requests through the proxy — main agent, Task sub-agents, and background
   *  tasks alike (independent of the tee/sentinel decision) — so the gateway can
   *  tell "CLI still working" apart from "truly idle" after the Stop hook. */
  onUpstreamActivity?: (info: UpstreamActivityInfo) => void;
}

/** Is this upstream error a transient connection fault safe to retry ONCE on a
 *  fresh socket (request body fully buffered, nothing streamed to the client yet)?
 *  Covers stale/torn pooled sockets (ECONNRESET/EPIPE/"socket hang up") AND a
 *  CORRUPTED pooled TLS socket — "bad record mac" / "decrypt error" / EPROTO —
 *  which surfaces under sub-agent fan-out when the keep-alive pool hands back a
 *  socket whose TLS record state got clobbered; the retry uses agent:false, so a
 *  brand-new socket is clean. We deliberately do NOT retry idle-timeouts or
 *  post-response errors (can't retry once bytes have streamed to the client). */
export function isRetriableUpstreamError(err: NodeJS.ErrnoException): boolean {
  return (
    err.code === "ECONNRESET" ||
    err.code === "EPIPE" ||
    err.code === "EPROTO" ||
    /socket hang up/i.test(err.message) ||
    /bad record mac|decrypt error/i.test(err.message)
  );
}

/**
 * Per-PTY forward proxy. The genuine `claude` CLI is pointed at this proxy via
 * ANTHROPIC_BASE_URL; every request is forwarded UNCHANGED to api.anthropic.com
 * (same method/path/headers/body, subscription OAuth token preserved → still
 * cc_entrypoint=cli, subsidy-safe — verified in Item A) and the response is
 * streamed back to the client byte-for-byte. The ONLY mutation is stripping the
 * client's `accept-encoding` so the SSE body comes back as plaintext we can
 * parse; the (now-uncompressed) response headers are forwarded as-is.
 *
 * When the upstream response is text/event-stream we tee a parsed copy of each
 * SSE `data:` event to `onEvent` — this is the live streaming source for the web
 * chat pane (word-by-word text, tool markers in true order, live context tokens).
 *
 * Tee gate (main-agent only): besides the real conversation turn, Claude Code fires
 * extra requests through this same proxy — haiku topic/title detection and quota
 * checks (NO tools), plus Task sub-agents (which run in-process, so their nested
 * /v1/messages flow through here too). We tee to `onEvent` ONLY the main agent's
 * turns, identified by a gateway-controlled sentinel (MAIN_AGENT_SENTINEL) that the
 * gateway injects into the main agent's appended system prompt. Sub-agents get
 * Claude Code's own system prompt (no sentinel) and aux calls carry no tools, so
 * both are suppressed — their output never leaks into the transcript.
 *
 * Why a gateway-owned sentinel and not a request fingerprint: the main agent's own
 * requests do NOT share a stable signature (tool set and system drift across a turn
 * as MCP tools/instructions load and per-request reminders are injected), so every
 * fingerprint heuristic we tried either dropped real turns (broke streaming) or
 * leaked sub-agents. The sentinel is the one signal the gateway fully controls.
 */
export class SsePtyProxy {
  private server: http.Server;
  /** Resolved listening port (0 until start() completes). */
  port = 0;

  private readonly requestFn: UpstreamRequestFn;
  private readonly upstreamHost: string;
  private readonly upstreamPort: number;
  private readonly primaryAgent: https.Agent | http.Agent | false;
  private readonly maxRequestBodyBytes: number;
  private readonly maxSseFrameBytes: number;
  private readonly onUpstreamActivity?: (info: UpstreamActivityInfo) => void;

  /** Upstream requests currently in flight (incremented at request start,
   *  decremented exactly once per request on end/error/client-abort). */
  activeStreams = 0;
  /** Epoch ms of the most recent upstream request start or completion. */
  lastUpstreamActivityAt = 0;

  constructor(
    private readonly label: string,
    private readonly onEvent: (e: SseDataEvent) => void,
    opts: SsePtyProxyOpts = {},
  ) {
    this.requestFn = opts.requestFn ?? https.request;
    this.upstreamHost = opts.upstream?.hostname ?? "api.anthropic.com";
    this.upstreamPort = opts.upstream?.port ?? 443;
    this.primaryAgent = opts.primaryAgent ?? upstreamAgent;
    this.maxRequestBodyBytes = opts.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
    this.maxSseFrameBytes = opts.maxSseFrameBytes ?? DEFAULT_MAX_SSE_FRAME_BYTES;
    this.onUpstreamActivity = opts.onUpstreamActivity;
    this.server = http.createServer((req, res) => this.handle(req, res));
    // node http servers throw on unhandled 'clientError'; swallow so a flaky
    // client socket can never crash the daemon.
    this.server.on("clientError", (err, socket) => {
      logger.warn(`SsePtyProxy[${this.label}] clientError: ${err.message}`);
      try { socket.destroy(); } catch { /* already gone */ }
    });
  }

  /** Bind to an ephemeral 127.0.0.1 port; resolves with the chosen port. */
  start(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const onErr = (err: Error) => reject(err);
      this.server.once("error", onErr);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", onErr);
        const addr = this.server.address();
        this.port = typeof addr === "object" && addr ? addr.port : 0;
        resolve(this.port);
      });
    });
  }

  /** Tear down the proxy. Safe to call multiple times. */
  stop(): void {
    try { this.server.close(); } catch { /* already closed */ }
  }

  /** Mark one upstream request started. Returns a ONCE-guarded `finish` that
   *  decrements on whichever terminal path fires first (response end, upstream
   *  error, client-gone abort) — later calls are no-ops, so overlapping terminal
   *  events can never double-decrement. Both edges notify onUpstreamActivity. */
  private streamStarted(): () => void {
    this.activeStreams += 1;
    this.lastUpstreamActivityAt = Date.now();
    this.notifyActivity();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.activeStreams = Math.max(0, this.activeStreams - 1);
      this.lastUpstreamActivityAt = Date.now();
      this.notifyActivity();
    };
  }

  private notifyActivity(): void {
    try {
      this.onUpstreamActivity?.({ activeStreams: this.activeStreams, lastActivityAt: this.lastUpstreamActivityAt });
    } catch (err) {
      logger.warn(`SsePtyProxy[${this.label}] onUpstreamActivity threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    let bodyBytes = 0;
    let bodyRejected = false;
    // Holder (not a plain `let`) so the req-close handler always destroys the
    // CURRENT in-flight upstream even after a retry swapped it out.
    const inflight: { current?: http.ClientRequest } = {};
    // ONE in-flight unit per CLIENT request (the retry reuses it — same logical
    // stream, so the count never double-dips on the fresh-socket attempt). Set
    // when the body is fully read and we actually go upstream.
    const tracked: { finish?: () => void } = {};
    const declaredLength = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > this.maxRequestBodyBytes) {
      res.writeHead(413, { "content-type": "text/plain; charset=utf-8" });
      res.end("Payload too large");
      req.resume();
      return;
    }
    req.on("data", (c: Buffer) => {
      if (bodyRejected) return;
      bodyBytes += c.length;
      if (bodyBytes > this.maxRequestBodyBytes) {
        bodyRejected = true;
        chunks.length = 0;
        res.writeHead(413, { "content-type": "text/plain; charset=utf-8" });
        res.end("Payload too large");
        return;
      }
      chunks.push(c);
    });
    req.on("error", () => { try { res.destroy(); } catch { /* ignore */ } });
    // Client (the claude CLI) hung up mid-turn — abort the in-flight upstream so
    // we don't keep streaming to a dead socket (resource leak per interrupted
    // turn). We listen on `res` 'close', NOT `req` 'close': req 'close' fires as
    // soon as the request body is fully read — which is BEFORE we've even sent
    // the response — and would destroy a perfectly healthy upstream (and silently
    // kill the retry). `res` 'close' with `!writableFinished` is the real
    // "client went away before we finished" signal.
    res.on("close", () => {
      if (!res.writableFinished) {
        try { inflight.current?.destroy(); } catch { /* ignore */ }
        // destroy() doesn't reliably emit 'error' on the upstream — settle the
        // in-flight count here too (finish is once-guarded, double-call safe).
        tracked.finish?.();
      }
    });
    req.on("end", () => {
      if (bodyRejected) return;
      const body = Buffer.concat(chunks);
      // Decide once per request whether to tee its events to the UI. Tool-bearing
      // requests (real agent turns) are teed; no-tools auxiliary calls are still
      // forwarded upstream but suppressed from the chat pane.
      const tee = this.shouldTeeToUi(body);
      const headers: Record<string, unknown> = { ...req.headers, host: this.upstreamHost };
      // Plaintext SSE so we can parse it; we then forward the (uncompressed)
      // upstream response headers as-is, so the client sees consistent framing.
      delete headers["accept-encoding"];

      tracked.finish = this.streamStarted();
      this.sendUpstream(req, res, body, tee, headers, inflight, 0, tracked.finish);
    });
  }

  /** Forward one buffered request upstream and stream the response back. On a
   *  "stale pooled socket" error before any response bytes, retry ONCE on a
   *  guaranteed-fresh socket (agent:false) — the keep-alive pool occasionally
   *  hands us a connection the server already half-closed, which surfaced to the
   *  CLI as a bare `502`. Anything else (or any error after streaming started)
   *  ends as 502 exactly as before. */
  private sendUpstream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Buffer,
    tee: boolean,
    headers: Record<string, unknown>,
    inflight: { current?: http.ClientRequest },
    attempt: number,
    finish: () => void,
  ): void {
    // First try over the shared keep-alive pool; the retry forces a brand-new
    // socket so we can't be handed the same dead one again.
    const agent = attempt === 0 ? this.primaryAgent : false;
    const upstream = this.requestFn(
      {
        hostname: this.upstreamHost,
        port: this.upstreamPort,
        path: req.url,
        method: req.method,
        headers: headers as http.OutgoingHttpHeaders,
        agent,
      },
      (uRes) => {
        res.writeHead(uRes.statusCode || 502, uRes.headers);
        const isSSE = String(uRes.headers["content-type"] || "").includes("text/event-stream");
        let sseBuf = "";
        let sseParsingEnabled = isSSE && tee;
        const sseDecoder = isSSE && tee ? new StringDecoder("utf8") : undefined;
        uRes.on("data", (chunk: Buffer) => {
          // Forward UNCHANGED to the client first (never let parsing affect the stream).
          // Standard backpressure: if the client's write buffer is full, pause the
          // upstream until 'drain' so a slow client can't balloon memory.
          try {
            if (!res.write(chunk)) {
              uRes.pause();
              res.once("drain", () => uRes.resume());
            }
          } catch { /* client gone */ }
          if (sseDecoder && sseParsingEnabled) {
            const parsed = this.parseSseBounded(sseBuf + sseDecoder.write(chunk));
            if (parsed === null) {
              sseParsingEnabled = false;
              sseBuf = "";
              logger.warn(`SsePtyProxy[${this.label}] SSE frame exceeded ${this.maxSseFrameBytes} bytes; tee parsing disabled for this response`);
            } else {
              sseBuf = parsed;
            }
          }
        });
        uRes.on("end", () => {
          if (sseDecoder && sseParsingEnabled) {
            const parsed = this.parseSseBounded(sseBuf + sseDecoder.end());
            if (parsed === null) {
              logger.warn(`SsePtyProxy[${this.label}] SSE frame exceeded ${this.maxSseFrameBytes} bytes at response end`);
            }
          }
          finish();
          try { res.end(); } catch { /* already ended */ }
        });
        uRes.on("error", (err) => {
          logger.warn(`SsePtyProxy[${this.label}] upstream response error: ${err instanceof Error ? err.message : String(err)}`);
          finish();
          try { res.destroy(err instanceof Error ? err : undefined); } catch { /* ignore */ }
        });
      },
    );
    inflight.current = upstream;
    upstream.on("error", (err: NodeJS.ErrnoException) => {
      // Retry only a connection that died before we committed any response, and
      // only once — a fresh socket can't fix a genuinely-down upstream. The retry
      // is the SAME logical stream, so `finish` is not called on this path (the
      // in-flight count carries over to the second attempt).
      if (attempt === 0 && !res.headersSent && isRetriableUpstreamError(err)) {
        logger.warn(`SsePtyProxy[${this.label}] upstream ${err.message} — retrying on fresh socket`);
        this.sendUpstream(req, res, body, tee, headers, inflight, attempt + 1, finish);
        return;
      }
      logger.warn(`SsePtyProxy[${this.label}] upstream error: ${err.message}`);
      finish();
      try {
        if (!res.headersSent) {
          res.writeHead(502);
          res.end();
        } else {
          res.destroy(err);
        }
      } catch { /* ignore */ }
    });
    upstream.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => {
      logger.warn(`SsePtyProxy[${this.label}] upstream idle-timeout — destroying`);
      try { upstream.destroy(new Error("upstream idle timeout")); } catch { /* ignore */ }
    });
    if (body.length) upstream.write(body);
    upstream.end();
  }

  /** Is this request the MAIN agent's stream (the only one teed to the UI)? Main =
   *  a tool-bearing request whose system carries the gateway's sentinel. No/empty
   *  tools => an auxiliary call (haiku topic/title detection, quota check); tools but
   *  no sentinel => a Task sub-agent (it gets Claude Code's own system prompt). Both
   *  are suppressed so only the main agent streams to the transcript. */
  private shouldTeeToUi(body: Buffer): boolean {
    let json: { tools?: unknown; system?: unknown } | null = null;
    try { json = JSON.parse(body.toString("utf-8")) as { tools?: unknown; system?: unknown }; }
    catch { return false; }                                          // non-JSON (e.g. count_tokens) — never a turn
    if (!Array.isArray(json?.tools) || json.tools.length === 0) return false; // aux call (no tools)
    return systemHasSentinel(json?.system);                          // sentinel present => main agent
  }

  /** Consume complete SSE frames (separated by a blank line) from `buf`, JSON.parse
   *  each event's `data:` payload, fire onEvent, and return the trailing incomplete
   *  remainder for the next chunk. Only ever called for the main agent's stream. */
  private parseSse(buf: string): string {
    return this.consumeSse(buf, Number.POSITIVE_INFINITY) ?? "";
  }

  /** Parse complete frames while rejecting both an oversized complete frame and
   *  an indefinitely growing incomplete frame. A null return disables only the
   *  observational tee; upstream bytes have already been forwarded unchanged. */
  private parseSseBounded(buf: string): string | null {
    return this.consumeSse(buf, this.maxSseFrameBytes);
  }

  private consumeSse(buf: string, maxFrameBytes: number): string | null {
    let idx: number;
    // Frames are delimited by a blank line. Handle both \n\n and \r\n\r\n.
    while ((idx = indexOfFrameEnd(buf)) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + frameDelimLen(buf, idx));
      if (Buffer.byteLength(raw, "utf8") > maxFrameBytes) return null;
      let dataStr = "";
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith("data:")) dataStr += line.slice(5).trimStart();
      }
      if (!dataStr || dataStr === "[DONE]") continue;
      let parsed: SseDataEvent;
      try { parsed = JSON.parse(dataStr) as SseDataEvent; } catch { continue; }
      try { this.onEvent(parsed); } catch (err) {
        logger.warn(`SsePtyProxy[${this.label}] onEvent threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (Buffer.byteLength(buf, "utf8") > maxFrameBytes) return null;
    return buf;
  }
}

/** Does the request's `system` (a string or a content-block array) carry the
 *  gateway's main-agent sentinel? */
function systemHasSentinel(system: unknown): boolean {
  if (typeof system === "string") return system.includes(MAIN_AGENT_SENTINEL);
  if (Array.isArray(system)) {
    return system.some(
      (b) =>
        typeof (b as { text?: unknown })?.text === "string" &&
        (b as { text: string }).text.includes(MAIN_AGENT_SENTINEL),
    );
  }
  return false;
}

/** Index of the first blank-line frame delimiter (\n\n or \r\n\r\n), or -1. */
function indexOfFrameEnd(buf: string): number {
  const a = buf.indexOf("\n\n");
  const b = buf.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function frameDelimLen(buf: string, idx: number): number {
  return buf.startsWith("\r\n\r\n", idx) ? 4 : 2;
}
