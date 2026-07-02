import fs from "node:fs";
import fsp from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { logger } from "../shared/logger.js";

export interface TranscriptTailer { stop(): void }

export interface TailTranscriptOpts {
  /** Poll interval backstopping fs.watch (which can miss the first appends on
   *  freshly-created files — and the file often doesn't exist when we attach). */
  pollMs: number;
  /** Engine label for the read-failure log line (e.g. "Codex", "antigravity"). */
  label: string;
}

/** Drain bursts in bounded slices instead of one transcript-sized allocation. */
const MAX_READ_CHUNK_BYTES = 1 << 20;
/** Backstop cadence once fs.watch is carrying the real-time load. */
const SLOW_POLL_MS = 2_000;
/** How long after the watcher attaches the fast poll keeps running — covers
 *  fs.watch missing the first appends on freshly-created files. */
const FAST_POLL_WINDOW_MS = 5_000;

/**
 * Tail a transcript JSONL from `startOffset`, invoking `onLine` for each complete
 * appended line. Shared by the codex and antigravity interactive engines (which
 * detect turn boundaries from their CLIs' on-disk transcripts — no hook system).
 *
 * Combines fs.watch with interval polling; handles partial-line buffering and
 * file-handle recovery on read errors. Concurrent wake-ups during a read are
 * coalesced into one follow-up pass (`pending`) so no append is left waiting for
 * the next poll tick. The poll runs at `pollMs` only while the watcher isn't
 * live (file missing, or just attached); after that it drops to a slow backstop
 * so a long turn doesn't stat the file 4-5×/sec on top of watch events.
 */
export function tailTranscriptLines(
  filePath: string,
  startOffset: number,
  onLine: (line: string) => void,
  opts: TailTranscriptOpts,
): TranscriptTailer {
  let offset = startOffset;
  let buf = "";
  let stopped = false;
  let fh: fsp.FileHandle | undefined;
  let reading = false;
  let pending = false;
  const decoder = new StringDecoder("utf8");

  const readNew = async (): Promise<void> => {
    if (stopped) return;
    if (reading) { pending = true; return; }
    reading = true;
    try {
      do {
        pending = false;
        let stat: fs.Stats;
        try { stat = await fsp.stat(filePath); } catch { return; }
        if (stat.size <= offset) return;
        if (!fh) {
          let opened: fsp.FileHandle;
          try { opened = await fsp.open(filePath, "r"); } catch { return; }
          if (stopped) {
            try { await opened.close(); } catch { /* ignore */ }
            return;
          }
          fh = opened;
        }
        if (stopped) return;
        const chunk = Buffer.alloc(Math.min(stat.size - offset, MAX_READ_CHUNK_BYTES));
        const { bytesRead } = await fh.read(chunk, 0, chunk.length, offset);
        offset += bytesRead;
        buf += decoder.write(chunk.subarray(0, bytesRead));
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) onLine(line);
        if (offset < stat.size) pending = true; // more than one slice — keep draining
      } while (pending && !stopped);
    } catch (err) {
      logger.warn(`${opts.label} transcript tail failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      try { await fh?.close(); } catch { /* ignore */ }
      fh = undefined;
    } finally {
      reading = false;
    }
  };

  let watcher: fs.FSWatcher | undefined;
  let watcherLiveAt = 0;
  const tryWatch = (): void => {
    if (watcher || stopped) return;
    try {
      watcher = fs.watch(filePath, () => { void readNew(); });
      watcherLiveAt = Date.now();
    } catch { /* file may not exist yet — the poll retries */ }
  };

  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  const schedulePoll = (): void => {
    if (stopped) return;
    const fast = !watcher || Date.now() - watcherLiveAt < FAST_POLL_WINDOW_MS;
    pollTimer = setTimeout(() => {
      tryWatch();
      void readNew().finally(schedulePoll);
    }, fast ? opts.pollMs : SLOW_POLL_MS);
    pollTimer.unref?.();
  };
  tryWatch();
  schedulePoll();
  const initialDrain = setTimeout(() => { void readNew(); }, 30);
  initialDrain.unref?.();

  return {
    stop() {
      stopped = true;
      watcher?.close();
      if (pollTimer) clearTimeout(pollTimer);
      clearTimeout(initialDrain);
      void fh?.close().catch(() => { /* ignore */ });
      fh = undefined;
    },
  };
}
