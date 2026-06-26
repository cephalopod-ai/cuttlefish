import { describe, it, expect } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { readJsonlTail } from "../jsonl-tail.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-jsonl-tail-"));

function write(name: string, content: string): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  return p;
}

describe("readJsonlTail", () => {
  it("returns empty for a missing file", async () => {
    const { entries, skipped } = await readJsonlTail(path.join(tmp, "nope.jsonl"), 10);
    expect(entries).toEqual([]);
    expect(skipped).toBe(0);
  });

  it("returns newest entries first and honors limit", async () => {
    const p = write("runs.jsonl", [1, 2, 3, 4, 5].map((n) => JSON.stringify({ n })).join("\n") + "\n");
    const { entries, skipped } = await readJsonlTail(p, 3);
    expect(entries).toEqual([{ n: 5 }, { n: 4 }, { n: 3 }]);
    expect(skipped).toBe(0);
  });

  it("skips a corrupt/truncated last line (crash mid-append)", async () => {
    const p = write("corrupt.jsonl", `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 })}\n{"n":3,"trunc`);
    const { entries, skipped } = await readJsonlTail(p, 10);
    expect(entries).toEqual([{ n: 2 }, { n: 1 }]);
    expect(skipped).toBe(1);
  });

  it("tail-reads large files, dropping the leading partial line", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) lines.push(JSON.stringify({ i, pad: "x".repeat(50) }));
    const p = write("big.jsonl", lines.join("\n") + "\n");
    // Force the tail path with a chunk smaller than the file.
    const { entries, skipped } = await readJsonlTail(p, 5, 1024);
    expect(entries.map((e) => (e as { i: number }).i)).toEqual([199, 198, 197, 196, 195]);
    expect(skipped).toBe(0);
  });
});
