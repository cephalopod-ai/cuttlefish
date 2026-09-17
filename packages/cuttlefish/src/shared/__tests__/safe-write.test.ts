import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  safeWriteFile,
  safeWriteJson,
  safeWriteYaml,
  safeWriteText,
} from "../safe-write.js";
import { verifyAuditChain } from "../audit-log.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "safe-write-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function leftoverTmps(): string[] {
  return fs.readdirSync(dir).filter((f) => f.includes(".tmp-"));
}

describe("safeWriteFile", () => {
  it("writes correct content and leaves no tmp turd", () => {
    const target = path.join(dir, "a.txt");
    safeWriteText(target, "hello");
    expect(fs.readFileSync(target, "utf-8")).toBe("hello");
    expect(leftoverTmps()).toEqual([]);
  });

  it("applies mode 0o600 when requested", () => {
    const target = path.join(dir, "secret.json");
    safeWriteFile(target, "x", { mode: 0o600 });
    const mode = fs.statSync(target).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("writes Buffer content", () => {
    const target = path.join(dir, "buf.bin");
    safeWriteFile(target, Buffer.from([1, 2, 3]));
    expect(Array.from(fs.readFileSync(target))).toEqual([1, 2, 3]);
  });

  it.each(["multibyte α🙂 text", Buffer.from([1, 2, 3, 4, 5])])("completes physically short writes for %s", (input) => {
    const target = path.join(dir, "short.bin");
    const originalWrite = fs.writeSync;
    const shortWrite = vi.spyOn(fs, "writeSync").mockImplementation((
      fd: number,
      data: string | NodeJS.ArrayBufferView,
      offset?: number | null,
      length?: number | BufferEncoding | null,
      position?: number | null,
    ) => {
      if (typeof data === "string") return originalWrite(fd, Buffer.from(data).subarray(0, 1));
      return originalWrite(fd, data, offset ?? 0, Math.min(typeof length === "number" ? length : data.byteLength, 1), position);
    });
    try {
      safeWriteFile(target, input);
      expect(fs.readFileSync(target)).toEqual(Buffer.from(input));
      expect(leftoverTmps()).toEqual([]);
    } finally {
      shortWrite.mockRestore();
    }
  });

  it("fsyncs the file fd and the parent dir fd by default", () => {
    const fsyncSpy = vi.spyOn(fs, "fsyncSync");
    const target = path.join(dir, "f.txt");
    safeWriteFile(target, "data");
    // At least two fsync calls: the file fd and the directory fd.
    expect(fsyncSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    fsyncSpy.mockRestore();
  });

  it("skips fsync when fsync:false", () => {
    const fsyncSpy = vi.spyOn(fs, "fsyncSync");
    safeWriteFile(path.join(dir, "g.txt"), "data", { fsync: false });
    expect(fsyncSpy).not.toHaveBeenCalled();
    fsyncSpy.mockRestore();
  });
});

describe("crash-safety", () => {
  it("a thrown validate leaves the prior target unchanged and writes no tmp", () => {
    const target = path.join(dir, "cfg.json");
    safeWriteJson(target, { v: "sentinel" }); // establish prior state
    expect(() =>
      safeWriteJson(target, { v: "new" }, {
        validate: () => {
          throw new Error("nope");
        },
      }),
    ).toThrow("nope");
    // Prior content survives — crash-safety proxy.
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({ v: "sentinel" });
    expect(leftoverTmps()).toEqual([]);
  });

  it("a write error cleans up the tmp file", () => {
    const target = path.join(dir, "h.txt");
    const writeSpy = vi.spyOn(fs, "writeSync").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(() => safeWriteFile(target, "data")).toThrow("disk full");
    writeSpy.mockRestore();
    expect(leftoverTmps()).toEqual([]);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("preserves the prior target when a partial write is followed by an error", () => {
    const target = path.join(dir, "prior.txt");
    fs.writeFileSync(target, "prior complete bytes");
    const originalWrite = fs.writeSync;
    const write = vi.spyOn(fs, "writeSync")
      .mockImplementationOnce((fd, data) => originalWrite(fd, Buffer.from(data).subarray(0, 1)))
      .mockImplementationOnce(() => { throw new Error("fixture disk full after partial write"); });
    try {
      expect(() => safeWriteFile(target, "new multibyte α🙂 bytes")).toThrow("fixture disk full after partial write");
      expect(fs.readFileSync(target, "utf-8")).toBe("prior complete bytes");
      expect(leftoverTmps()).toEqual([]);
    } finally {
      write.mockRestore();
    }
  });
});

describe("backup rotation", () => {
  it("keeps last-N previous versions", () => {
    const target = path.join(dir, "rot.txt");
    safeWriteFile(target, "v1", { backups: 2 });
    safeWriteFile(target, "v2", { backups: 2 });
    safeWriteFile(target, "v3", { backups: 2 });
    expect(fs.readFileSync(target, "utf-8")).toBe("v3");
    expect(fs.readFileSync(`${target}.bak.1`, "utf-8")).toBe("v2");
    expect(fs.readFileSync(`${target}.bak.2`, "utf-8")).toBe("v1");
    // Only N backups retained.
    expect(fs.existsSync(`${target}.bak.3`)).toBe(false);
  });
});

describe("format helpers", () => {
  it("JSON round-trips", () => {
    const target = path.join(dir, "j.json");
    safeWriteJson(target, { a: 1, b: [2, 3] });
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({ a: 1, b: [2, 3] });
  });

  it("YAML round-trips", () => {
    const target = path.join(dir, "y.yaml");
    safeWriteYaml(target, { a: 1, nested: { b: "two" } });
    const back = fs.readFileSync(target, "utf-8");
    expect(back).toContain("a: 1");
    expect(back).toContain("b: two");
  });
});

describe("audit integration", () => {
  it("appends a chained audit record when audit opts given", () => {
    const auditLog = path.join(dir, "audit.jsonl");
    const target = path.join(dir, "audited.json");
    safeWriteJson(target, { x: 1 }, { audit: { actor: "test", auditLogPath: auditLog } });
    safeWriteJson(target, { x: 2 }, { audit: { actor: "test", auditLogPath: auditLog } });
    const result = verifyAuditChain(auditLog);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.count).toBe(2);
  });

  it("does not write an audit record when audit opts omitted", () => {
    const auditLog = path.join(dir, "audit.jsonl");
    safeWriteJson(path.join(dir, "n.json"), { x: 1 });
    expect(fs.existsSync(auditLog)).toBe(false);
  });
});
