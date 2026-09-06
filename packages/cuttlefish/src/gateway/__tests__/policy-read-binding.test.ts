import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

// CUTTLEFISH_HOME must be redirected before the module under test loads, since
// read-security captures it at import time.
const { home: tmpHome } = withStaticTempCuttlefishHome("cuttlefish-policy-read-");

type ReadSecurity = typeof import("../files/read-security.js");
let readSecurity: ReadSecurity;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-policy-read-scratch-"));

beforeAll(async () => {
  readSecurity = await import("../files/read-security.js");
});

function contextWithRoots(roots: string[]) {
  return { getConfig: () => ({ gateway: { fileReadRoots: roots } }) } as never;
}

describe("readFileUnderPolicy — the policy decision and the bytes name one inode (UPS-A1)", () => {
  it("returns the file's own bytes and its canonical path", () => {
    const target = path.join(scratch, "plain.txt");
    fs.writeFileSync(target, "hello");

    const read = readSecurity.readFileUnderPolicy(target, { maxBytes: 1024 });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.buffer.toString()).toBe("hello");
    expect(read.size).toBe(5);
    expect(read.realPath).toBe(fs.realpathSync.native(target));
  });

  it("refuses a symlinked leaf outright rather than following it", () => {
    const secret = path.join(scratch, "target-secret.txt");
    fs.writeFileSync(secret, "s3cret");
    const link = path.join(scratch, "link-to-secret.txt");
    fs.rmSync(link, { force: true });
    fs.symlinkSync(secret, link);

    const read = readSecurity.readFileUnderPolicy(link, { maxBytes: 1024 });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe("symlink");
  });

  it("judges the denylist against the canonical path, not the spelling requested", () => {
    // A benign-looking directory that is really a symlink to the caller's ~/.ssh:
    // the leaf is an ordinary file, so only canonicalising the whole chain
    // catches it.
    const sshDir = path.join(os.homedir(), ".ssh");
    if (!fs.existsSync(sshDir)) return; // nothing to canonicalise into on this host

    const aliasDir = path.join(scratch, "keys-alias");
    fs.rmSync(aliasDir, { force: true });
    try {
      fs.symlinkSync(sshDir, aliasDir, "dir");
    } catch {
      return; // symlinking into $HOME is not permitted here
    }

    const probe = path.join(aliasDir, "id_rsa");
    const read = readSecurity.readFileUnderPolicy(probe, { maxBytes: 1024 });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    // Either the key is absent (not_found) or the policy refuses it, but the
    // canonical path must never be read as an ordinary file.
    expect(["blocked", "not_found"]).toContain(read.code);
  });

  it("refuses a path whose real location escapes fileReadRoots", () => {
    const allowed = path.join(scratch, "allowed");
    const elsewhere = path.join(scratch, "elsewhere");
    fs.mkdirSync(allowed, { recursive: true });
    fs.mkdirSync(elsewhere, { recursive: true });
    const outside = path.join(elsewhere, "note.txt");
    fs.writeFileSync(outside, "not yours");

    const inside = path.join(allowed, "note.txt");
    const direct = readSecurity.readFileUnderPolicy(outside, {
      maxBytes: 1024,
      context: contextWithRoots([allowed]),
    });
    expect(direct.ok).toBe(false);
    if (!direct.ok) expect(direct.code).toBe("outside_roots");

    // And the same file reached through a link inside the allowed root.
    fs.rmSync(inside, { force: true });
    fs.symlinkSync(outside, inside);
    const viaLink = readSecurity.readFileUnderPolicy(inside, {
      maxBytes: 1024,
      context: contextWithRoots([allowed]),
    });
    expect(viaLink.ok).toBe(false);
    if (!viaLink.ok) expect(viaLink.code).toBe("symlink");
  });

  it("enforces the size cap from the held descriptor and reports the real size", () => {
    const big = path.join(scratch, "big.txt");
    fs.writeFileSync(big, "x".repeat(4096));

    const read = readSecurity.readFileUnderPolicy(big, { maxBytes: 1024 });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe("too_large");
    expect(read.size).toBe(4096);
  });

  it("refuses a directory and a missing path with distinguishable codes", () => {
    const dir = path.join(scratch, "a-dir");
    fs.mkdirSync(dir, { recursive: true });

    const asDir = readSecurity.readFileUnderPolicy(dir, { maxBytes: 1024 });
    expect(asDir.ok).toBe(false);
    if (!asDir.ok) expect(asDir.code).toBe("not_a_file");

    const missing = readSecurity.readFileUnderPolicy(path.join(scratch, "nope.txt"), { maxBytes: 1024 });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("not_found");
  });

  it("still refuses a denied basename reached by an ordinary path", () => {
    const env = path.join(scratch, ".env");
    fs.writeFileSync(env, "SECRET=1");

    const read = readSecurity.readFileUnderPolicy(env, { maxBytes: 1024 });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.code).toBe("blocked");
  });

  it("refuses a FIFO without blocking on the open", () => {
    // Regression: opening a path before knowing what it names will hang the
    // gateway's only thread on a fifo unless the open is non-blocking. The
    // assertion that matters here is that this test terminates at all.
    const fifo = path.join(scratch, "a-fifo");
    fs.rmSync(fifo, { force: true });
    try {
      execFileSync("mkfifo", [fifo]);
    } catch {
      return; // no mkfifo on this platform (Windows) — nothing to prove
    }

    const started = Date.now();
    const read = readSecurity.readFileUnderPolicy(fifo, { maxBytes: 1024 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.code).toBe("not_a_file");
  });

  it("reads a zero-byte file without error", () => {
    const empty = path.join(scratch, "empty.txt");
    fs.writeFileSync(empty, "");
    const read = readSecurity.readFileUnderPolicy(empty, { maxBytes: 1024 });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.size).toBe(0);
  });
});

describe("classifyBuffer — classification without re-opening the path", () => {
  it("marks a NUL-bearing buffer binary and leaves text readable", () => {
    const binary = readSecurity.classifyBuffer("x.txt", Buffer.from([0x41, 0x00, 0x42]));
    expect(binary.binary).toBe(true);
    expect(binary.content).toBeUndefined();

    const text = readSecurity.classifyBuffer("x.txt", Buffer.from("plain words"));
    expect(text.binary).toBe(false);
    expect(text.content).toBe("plain words");
    expect(text.size).toBe("plain words".length);
  });

  it("uses the extension for a binary mime even when the bytes look textual", () => {
    const c = readSecurity.classifyBuffer("photo.png", Buffer.from("not really a png"));
    expect(c.binary).toBe(true);
  });
});

describe("tmpHome fixture", () => {
  it("redirected CUTTLEFISH_HOME away from the operator's real instance", () => {
    expect(tmpHome).not.toBe(path.join(os.homedir(), ".cuttlefish"));
  });
});
