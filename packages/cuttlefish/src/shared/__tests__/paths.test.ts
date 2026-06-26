import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_PATH,
  CRON_JOBS,
  CUTTLEFISH_HOME,
  getCuttlefishPaths,
  refreshCuttlefishPaths,
  resolveHome,
  setCuttlefishHomeForTest,
} from "../paths.js";

const prevHome = process.env.CUTTLEFISH_HOME;
const PKG = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

afterEach(() => {
  if (prevHome === undefined) delete process.env.CUTTLEFISH_HOME;
  else process.env.CUTTLEFISH_HOME = prevHome;
  refreshCuttlefishPaths();
});

describe("Cuttlefish runtime paths", () => {
  it("computes paths from an explicit environment without mutating exports", () => {
    const home = path.join(os.tmpdir(), "cuttlefish-paths-explicit");
    const paths = getCuttlefishPaths({ CUTTLEFISH_HOME: home });

    expect(paths.CUTTLEFISH_HOME).toBe(home);
    expect(paths.CONFIG_PATH).toBe(path.join(home, "config.yaml"));
    expect(paths.CRON_JOBS).toBe(path.join(home, "cron", "jobs.json"));
    expect(CUTTLEFISH_HOME).not.toBe(home);
  });

  it("refreshes live bindings without re-importing modules", () => {
    const home = path.join(os.tmpdir(), "cuttlefish-paths-live");

    setCuttlefishHomeForTest(home);

    expect(process.env.CUTTLEFISH_HOME).toBe(home);
    expect(CUTTLEFISH_HOME).toBe(home);
    expect(CONFIG_PATH).toBe(path.join(home, "config.yaml"));
    expect(CRON_JOBS).toBe(path.join(home, "cron", "jobs.json"));
  });

  it("rejects non-canonical instance names when resolving implicit homes", () => {
    const upstreamName = ["ji", "nn"].join("");

    expect(() => resolveHome({ CUTTLEFISH_INSTANCE: upstreamName })).toThrow(/one local instance/);
    expect(() => resolveHome({
      CUTTLEFISH_HOME: path.join(os.tmpdir(), "cuttlefish-explicit"),
      CUTTLEFISH_INSTANCE: upstreamName,
    })).toThrow(/one local instance/);
  });

  it("keeps the standalone hook relay from deriving homes from instance names", () => {
    const relay = fs.readFileSync(path.join(PKG, "assets", "hook-relay.mjs"), "utf-8");

    expect(relay).toContain('path.join(os.homedir(), ".cuttlefish")');
    expect(relay).not.toContain("CUTTLEFISH_INSTANCE");
  });

  it("does not reintroduce the upstream gateway port in runtime package surfaces", () => {
    const legacyPort = ["77", "77"].join("");
    const checkedRoots = ["src", "template", "assets"].map((dir) => path.join(PKG, dir));
    const hits: string[] = [];

    for (const root of checkedRoots) collectLegacyPortHits(root, legacyPort, hits);

    expect(hits).toEqual([]);
  });
});

function collectLegacyPortHits(root: string, legacyPort: string, hits: string[]): void {
  const ignoredDirs = new Set(["dist", "out", "node_modules", ".turbo"]);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (ignoredDirs.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      collectLegacyPortHits(full, legacyPort, hits);
      continue;
    }
    if (!entry.isFile()) continue;
    const text = fs.readFileSync(full, "utf-8");
    if (text.includes(legacyPort)) hits.push(path.relative(PKG, full));
  }
}
