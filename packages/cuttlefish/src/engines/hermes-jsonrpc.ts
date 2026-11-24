// packages/cuttlefish/src/engines/hermes-jsonrpc.ts
import type { Writable, Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { isPlainObject } from "../shared/plain-object.js";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

interface StrictFraming {
  maxFrameBytes: number;
  onError: (error: Error) => void;
}

/** Newline-delimited JSON-RPC used by the local ACP and MSP hosts. */
export class HermesRpc {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private notifyCb?: (method: string, params: Record<string, unknown>) => void;
  private serverReqCb?: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;
  private buf = "";
  private readonly decoder = new StringDecoder("utf8");
  private readonly strictDecoder = new TextDecoder("utf-8", { fatal: true });
  private frameBytes = 0;
  private framingFailed = false;

  constructor(private stdin: Writable, stdout: Readable, private strict?: StrictFraming) {
    stdout.on("data", (d: Buffer) => this.onData(d));
    if (strict) stdout.on("end", () => {
      if (this.frameBytes) this.failFraming("incomplete JSON-RPC frame");
    });
  }

  request<T = unknown>(method: string, params?: object): Promise<T> {
    const id = this.nextId++;
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    if (this.strict && Buffer.byteLength(line) > this.strict.maxFrameBytes) {
      return Promise.reject(new Error("oversized outgoing JSON-RPC frame"));
    }
    const p = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
    this.stdin.write(line);
    return p;
  }

  notify(method: string, params?: object): void {
    this.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  onNotification(cb: (method: string, params: Record<string, unknown>) => void): void { this.notifyCb = cb; }
  onServerRequest(cb: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>): void { this.serverReqCb = cb; }

  rejectAll(err: Error): void {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  private onData(d: Buffer): void {
    if (this.framingFailed) return;
    if (this.strict) {
      let start = 0;
      for (let end = d.indexOf(10); end >= 0; end = d.indexOf(10, start)) {
        if (this.frameBytes + end - start > this.strict.maxFrameBytes) {
          this.failFraming("oversized JSON-RPC frame");
          return;
        }
        if (!this.decodeStrict(d.subarray(start, end + 1), false)) return;
        const line = this.buf.trim();
        this.buf = "";
        this.frameBytes = 0;
        if (line) this.handleLine(line);
        if (this.framingFailed) return;
        start = end + 1;
      }
      this.frameBytes += d.length - start;
      if (this.frameBytes > this.strict.maxFrameBytes) {
        this.failFraming("oversized JSON-RPC frame");
        return;
      }
      this.decodeStrict(d.subarray(start), true);
      return;
    }
    this.buf += this.decoder.write(d);
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private decodeStrict(bytes: Buffer, stream: boolean): boolean {
    try {
      this.buf += this.strictDecoder.decode(bytes, { stream });
      return true;
    } catch {
      this.failFraming("invalid UTF-8 in JSON-RPC frame");
      return false;
    }
  }

  private handleLine(line: string): void {
    try {
      const msg: unknown = JSON.parse(line);
      if (!isPlainObject(msg)) throw new Error("invalid envelope");
      if (this.strict) {
        const notification = typeof msg.method === "string" && !("id" in msg);
        const response = typeof msg.id === "number" && !("method" in msg)
          && (("result" in msg) !== ("error" in msg));
        const request = !!this.serverReqCb && typeof msg.method === "string"
          && (typeof msg.id === "number" || typeof msg.id === "string");
        if (msg.jsonrpc !== "2.0" || !(notification || response || request)) throw new Error("invalid envelope");
      }
      void this.handle(msg).catch(() => this.failFraming("JSON-RPC handler failed"));
    } catch {
      this.failFraming("invalid JSON-RPC frame");
    }
  }

  private failFraming(message: string): void {
    if (!this.strict || this.framingFailed) return;
    this.framingFailed = true;
    this.buf = "";
    const error = new Error(message);
    this.rejectAll(error);
    this.strict.onError(error);
  }

  private async handle(msg: Record<string, unknown>): Promise<void> {
    const id = msg.id;
    if (typeof id === "number" && (("result" in msg) || ("error" in msg))) {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if ("error" in msg && msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if ((typeof id === "number" || typeof id === "string") && typeof msg.method === "string") {
      // server→client request: answer it
      try {
        const result = this.serverReqCb ? await this.serverReqCb(msg.method, (msg.params ?? {}) as Record<string, unknown>) : null;
        this.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
      } catch (e) {
        // Don't fake success on a failed server→client turn: send a real
        // JSON-RPC error response so the caller can tell the turn failed.
        const message = e instanceof Error ? e.message : String(e);
        this.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) + "\n");
      }
      return;
    }
    if (typeof msg.method === "string") {
      this.notifyCb?.(msg.method, (msg.params ?? {}) as Record<string, unknown>);
    }
  }
}
