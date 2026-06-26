import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendAudit, sha256Hex, verifyAuditChain, type AuditRecord } from "../audit-log.js";

let dir: string;
let log: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-log-"));
  log = path.join(dir, "audit.jsonl");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function readRecords(): AuditRecord[] {
  return fs
    .readFileSync(log, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as AuditRecord);
}

describe("appendAudit", () => {
  it("produces parseable JSONL", () => {
    appendAudit({ actor: "a", file: "/f", checksum: "c1", auditLogPath: log });
    const recs = readRecords();
    expect(recs).toHaveLength(1);
    expect(recs[0].actor).toBe("a");
    expect(recs[0].file).toBe("/f");
    expect(recs[0].op).toBe("write"); // default op
  });

  it("first record has prev_checksum null", () => {
    appendAudit({ actor: "a", file: "/f", checksum: "c1", auditLogPath: log });
    expect(readRecords()[0].prev_checksum).toBeNull();
  });

  it("chains prev_checksum(N) == checksum(N-1)", () => {
    appendAudit({ actor: "a", file: "/f", checksum: "c1", auditLogPath: log });
    appendAudit({ actor: "a", file: "/f", checksum: "c2", auditLogPath: log });
    appendAudit({ actor: "a", file: "/f", checksum: "c3", auditLogPath: log });
    const recs = readRecords();
    expect(recs[1].prev_checksum).toBe(recs[0].checksum);
    expect(recs[2].prev_checksum).toBe(recs[1].checksum);
  });
});

describe("sha256Hex", () => {
  it("checksum equals sha256 of the bytes", () => {
    const bytes = Buffer.from("the payload", "utf-8");
    const sum = sha256Hex(bytes);
    appendAudit({ actor: "a", file: "/f", checksum: sum, auditLogPath: log });
    expect(readRecords()[0].checksum).toBe(sum);
    // Deterministic + matches string form.
    expect(sha256Hex("the payload")).toBe(sum);
  });
});

describe("verifyAuditChain", () => {
  it("returns ok for a valid chain", () => {
    appendAudit({ actor: "a", file: "/f", checksum: "c1", auditLogPath: log });
    appendAudit({ actor: "a", file: "/f", checksum: "c2", auditLogPath: log });
    const r = verifyAuditChain(log);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.count).toBe(2);
  });

  it("returns ok:true count:0 for a missing ledger", () => {
    const r = verifyAuditChain(path.join(dir, "nope.jsonl"));
    expect(r).toEqual({ ok: true, count: 0 });
  });

  it("detects a broken link when a middle record is tampered", () => {
    appendAudit({ actor: "a", file: "/f", checksum: "c1", auditLogPath: log });
    appendAudit({ actor: "a", file: "/f", checksum: "c2", auditLogPath: log });
    appendAudit({ actor: "a", file: "/f", checksum: "c3", auditLogPath: log });
    const recs = readRecords();
    recs[1].checksum = "tampered"; // breaks link to recs[2].prev_checksum
    fs.writeFileSync(log, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const r = verifyAuditChain(log);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.index).toBe(2);
  });
});
