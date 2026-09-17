import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-files-sec-"));
process.env.CUTTLEFISH_HOME = tmpHome;

type Files = typeof import("../files.js");
type Paths = typeof import("../../shared/paths.js");

let files: Files;
let paths: Paths;

beforeAll(async () => {
  paths = await import("../../shared/paths.js");
  files = await import("../files.js");
});

describe("file read secret protection", () => {
  it("blocks high-risk secret paths while allowing normal project files", () => {
    const secretDir = path.join(tmpHome, "secrets");
    fs.mkdirSync(secretDir, { recursive: true });
    const secret = path.join(secretDir, "api.txt");
    const normal = path.join(tmpHome, "notes.txt");
    fs.writeFileSync(secret, "TOKEN=should-not-leak");
    fs.writeFileSync(normal, "hello");

    expect(files.assessFileRead(secret, { authenticated: true }).allowed).toBe(false);
    expect(files.assessFileRead(path.join(os.homedir(), ".ssh", "id_rsa"), { authenticated: true }).allowed).toBe(false);
    expect(files.assessFileRead(path.join(tmpHome, "project", ".env.local"), { authenticated: true }).allowed).toBe(false);
    expect(files.assessFileRead(path.join(tmpHome, "project", ".envrc"), { authenticated: true }).allowed).toBe(false);
    expect(files.assessFileRead(normal, { authenticated: true }).allowed).toBe(true);
  });

  it("blocks the gateway admin-token file and the expanded credential blocklist (CF2-101/CF2-201)", () => {
    expect(files.assessFileRead(paths.GATEWAY_INFO_FILE, { authenticated: true }).allowed).toBe(false);
    expect(files.assessFileRead(path.join(os.homedir(), ".claude", ".credentials.json"), { authenticated: true }).allowed).toBe(false);
    expect(files.assessFileRead(path.join(os.homedir(), ".aws", "credentials"), { authenticated: true }).allowed).toBe(false);
    expect(files.assessFileRead(path.join(os.homedir(), ".kube", "config"), { authenticated: true }).allowed).toBe(false);
    expect(files.assessFileRead(path.join(os.homedir(), ".docker", "config.json"), { authenticated: true }).allowed).toBe(false);
    expect(files.assessFileRead(path.join(os.homedir(), ".npmrc"), { authenticated: true }).allowed).toBe(false);
    expect(files.assessFileRead(path.join(os.homedir(), ".netrc"), { authenticated: true }).allowed).toBe(false);
    expect(files.assessFileRead(path.join(os.homedir(), ".git-credentials"), { authenticated: true }).allowed).toBe(false);
    expect(files.assessFileRead(path.join(os.homedir(), ".config", "gcloud", "application_default_credentials.json"), { authenticated: true }).allowed).toBe(false);
    // A same-named "config" file outside .kube must not be swept up by the scoped rule.
    expect(files.assessFileRead(path.join(tmpHome, "project", "config"), { authenticated: true }).allowed).toBe(true);
  });

  it("blocks symlink bypasses that point at denied secret files", () => {
    const secretDir = path.join(tmpHome, "secrets");
    const secret = path.join(secretDir, "plain-name.txt");
    const link = path.join(tmpHome, "project", "notes.txt");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.writeFileSync(secret, "raw-token-that-should-not-leak");
    fs.symlinkSync(secret, link);

    expect(files.assessFileRead(link, { authenticated: true }).allowed).toBe(false);
  });

  it("redacts sensitive text content before returning it to the UI", () => {
    const file = path.join(tmpHome, "output.txt");
    fs.writeFileSync(file, "OPENAI_API_KEY=sk-test...cdef\nhello");
    const c = files.classifyFile(file);
    expect(c.content).toContain("[REDACTED]");
    expect(c.content).not.toContain("sk-test...cdef");
  });
});

describe("file upload side effects", () => {
  it("rejects custom upload paths outside managed storage", () => {
    expect(files.resolveCustomUploadPath("/tmp/owned.txt")).toBeNull();
    expect(files.resolveCustomUploadPath(path.join(paths.FILES_DIR, "..", "..", "owned.txt"))).toBeNull();
  });

  it("allows custom upload paths only inside managed storage roots", () => {
    const managed = path.join(paths.FILES_DIR, "custom", "note.txt");
    expect(files.resolveCustomUploadPath(managed)).toBe(path.resolve(managed));
  });

  it("keeps automatic file opening disabled unless explicitly opted in", () => {
    expect(files.allowUploadedFileOpen({ getConfig: () => ({ gateway: {} }) } as any)).toBe(false);
    expect(files.allowUploadedFileOpen({ getConfig: () => ({ gateway: { allowFileOpen: true } }) } as any)).toBe(true);
  });

  it("does not invent a custom remote filesystem path unless explicitly requested", () => {
    expect(files.buildRemoteUploadBody("note.txt", Buffer.from("hello"), null)).toEqual({
      filename: "note.txt",
      content: Buffer.from("hello").toString("base64"),
    });
    expect(files.buildRemoteUploadBody("note.txt", Buffer.from("hello"), "~/inbox/note.txt")).toEqual({
      filename: "note.txt",
      content: Buffer.from("hello").toString("base64"),
      path: "~/inbox/note.txt",
    });
  });

  it("adds remote bearer auth only for configured remotes with a token", () => {
    const config = {
      remotes: {
        prod: { url: "https://cuttlefish.example.test/", token: "remote-token" },
        demo: { url: "https://demo.example.test" },
      },
    };

    expect(files.remoteUploadHeaders("https://cuttlefish.example.test", config as any)).toEqual({
      "Content-Type": "application/json",
      authorization: "Bearer remote-token",
    });
    expect(files.remoteUploadHeaders("https://demo.example.test", config as any)).toEqual({
      "Content-Type": "application/json",
    });
  });
});

describe("generated resolved MCP file policy", () => {
  async function generatedFixture(sessionId: string) {
    const { writeMcpConfigFile } = await import("../../mcp/resolver.js");
    // Normal producer, inert command and harmless strings: no process is run.
    return writeMcpConfigFile({ mcpServers: {
      fixture: { command: "fixture-never-spawned", env: { FIXTURE_VALUE: "ordinary-value" } },
    } }, sessionId);
  }

  it("refuses the normal producer output before returning bytes", async () => {
    const generated = await generatedFixture("policy-direct");
    try {
      expect(fs.statSync(generated).mode & 0o777).toBe(0o600);
      const read = files.readFileUnderPolicy(generated, {
        maxBytes: 1024, authenticated: true,
        context: { getConfig: () => ({ gateway: {} }) } as any,
      });
      expect(read).toMatchObject({ ok: false, code: "blocked" });
      expect(read).not.toHaveProperty("buffer");
    } finally { fs.rmSync(generated, { force: true }); }
  });

  it("retains the sensitive-path refusal when arbitrary reads are enabled", async () => {
    const generated = await generatedFixture("policy-arbitrary");
    try {
      expect(files.readFileUnderPolicy(generated, {
        maxBytes: 1024,
        context: { getConfig: () => ({ gateway: { allowArbitraryFileRead: true } }) } as any,
      })).toMatchObject({ ok: false, code: "blocked" });
    } finally { fs.rmSync(generated, { force: true }); }
  });

  it("recognizes a canonical path through a directory alias", async () => {
    const generated = await generatedFixture("policy-alias");
    const alias = path.join(tmpHome, "mcp-directory-alias");
    fs.symlinkSync(path.dirname(generated), alias, "dir");
    const requested = path.join(alias, path.basename(generated));
    try {
      expect(files.assessFileRead(requested).allowed).toBe(false);
      expect(files.readFileUnderPolicy(requested, { maxBytes: 1024 })).toMatchObject({ ok: false, code: "blocked" });
    } finally {
      fs.unlinkSync(alias);
      fs.rmSync(generated, { force: true });
    }
  });

  it("continues reading ordinary managed text and reports a missing file", () => {
    const normal = path.join(tmpHome, "ordinary-managed.txt");
    fs.writeFileSync(normal, "ordinary fixture text");
    const read = files.readFileUnderPolicy(normal, { maxBytes: 1024 });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.buffer.toString()).toBe("ordinary fixture text");
    expect(files.readFileUnderPolicy(path.join(tmpHome, "missing-fixture.txt"), { maxBytes: 1024 }))
      .toMatchObject({ ok: false, code: "not_found" });
  });

  it("refuses canonical producer output when the MCP directory is an alias", async () => {
    const mcpDir = path.join(tmpHome, "tmp", "mcp");
    const backup = `${mcpDir}-fixture-backup`;
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-mcp-root-alias-fixture-"));
    fs.renameSync(mcpDir, backup);
    fs.symlinkSync(external, mcpDir, "dir");
    try {
      const generated = await generatedFixture("policy-root-alias");
      const canonical = fs.realpathSync.native(generated);
      expect(files.assessFileRead(canonical).allowed).toBe(false);
      expect(files.readFileUnderPolicy(generated, {
        maxBytes: 1024,
        context: { getConfig: () => ({ gateway: { allowArbitraryFileRead: true } }) } as any,
      })).toMatchObject({ ok: false, code: "blocked" });
    } finally {
      fs.unlinkSync(mcpDir);
      fs.renameSync(backup, mcpDir);
      fs.rmSync(external, { recursive: true, force: true });
    }
  });
});
