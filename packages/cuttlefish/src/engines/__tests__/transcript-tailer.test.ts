import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tailTranscriptLines, type TranscriptTailer } from "../transcript-tailer.js";

const OPTS = { pollMs: 25, label: "Test" };

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tailer-test-"));
  return path.join(dir, "transcript.jsonl");
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(cond()).toBe(true);
}

describe("tailTranscriptLines", () => {
  it("emits each complete appended line", async () => {
    const file = tmpFile();
    fs.writeFileSync(file, "");
    const lines: string[] = [];
    let tailer: TranscriptTailer | undefined;
    try {
      tailer = tailTranscriptLines(file, 0, (l) => lines.push(l), OPTS);
      fs.appendFileSync(file, "one\ntwo\n");
      await waitFor(() => lines.length === 2);
      expect(lines).toEqual(["one", "two"]);
    } finally {
      tailer?.stop();
    }
  });

  it("buffers a partial line until the newline arrives", async () => {
    const file = tmpFile();
    fs.writeFileSync(file, "");
    const lines: string[] = [];
    let tailer: TranscriptTailer | undefined;
    try {
      tailer = tailTranscriptLines(file, 0, (l) => lines.push(l), OPTS);
      fs.appendFileSync(file, "par");
      await new Promise((r) => setTimeout(r, 100)); // a few poll ticks
      expect(lines).toEqual([]); // no newline yet — nothing emitted
      fs.appendFileSync(file, "tial\n");
      await waitFor(() => lines.length === 1);
      expect(lines).toEqual(["partial"]);
    } finally {
      tailer?.stop();
    }
  });

  it("starts at startOffset — pre-existing content is not replayed", async () => {
    const file = tmpFile();
    fs.writeFileSync(file, "old-history\n");
    const offset = fs.statSync(file).size;
    const lines: string[] = [];
    let tailer: TranscriptTailer | undefined;
    try {
      tailer = tailTranscriptLines(file, offset, (l) => lines.push(l), OPTS);
      fs.appendFileSync(file, "fresh\n");
      await waitFor(() => lines.length === 1);
      expect(lines).toEqual(["fresh"]);
    } finally {
      tailer?.stop();
    }
  });

  it("tolerates the file not existing yet and picks it up once created", async () => {
    const file = tmpFile(); // path allocated but never written
    const lines: string[] = [];
    let tailer: TranscriptTailer | undefined;
    try {
      tailer = tailTranscriptLines(file, 0, (l) => lines.push(l), OPTS);
      await new Promise((r) => setTimeout(r, 60));
      fs.writeFileSync(file, "late\n");
      await waitFor(() => lines.length === 1);
      expect(lines).toEqual(["late"]);
    } finally {
      tailer?.stop();
    }
  });

  it("stop() halts emission", async () => {
    const file = tmpFile();
    fs.writeFileSync(file, "");
    const lines: string[] = [];
    const tailer = tailTranscriptLines(file, 0, (l) => lines.push(l), OPTS);
    fs.appendFileSync(file, "before\n");
    await waitFor(() => lines.length === 1);
    tailer.stop();
    fs.appendFileSync(file, "after\n");
    await new Promise((r) => setTimeout(r, 100));
    expect(lines).toEqual(["before"]);
  });

  it("survives an onLine callback that throws (logs instead of unhandled rejection)", async () => {
    const file = tmpFile();
    fs.writeFileSync(file, "");
    const lines: string[] = [];
    let tailer: TranscriptTailer | undefined;
    try {
      tailer = tailTranscriptLines(file, 0, (l) => {
        if (l === "boom") throw new Error("parser exploded");
        lines.push(l);
      }, OPTS);
      fs.appendFileSync(file, "boom\n");
      await new Promise((r) => setTimeout(r, 80));
      fs.appendFileSync(file, "ok\n");
      await waitFor(() => lines.length === 1);
      expect(lines).toEqual(["ok"]);
    } finally {
      tailer?.stop();
    }
  });
});
