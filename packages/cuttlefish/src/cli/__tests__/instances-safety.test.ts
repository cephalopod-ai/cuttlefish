import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSafeDestructiveHome,
  assertSafeManagedInstanceHome,
  type Instance,
} from "../instances.js";

function instance(name: string, home: string): Instance {
  return {
    name,
    home,
    port: 7788,
    createdAt: new Date(0).toISOString(),
  };
}

describe("instance destructive path safety", () => {
  it("rejects catastrophic deletion targets", () => {
    expect(() => assertSafeDestructiveHome(path.parse(os.homedir()).root)).toThrow(/filesystem root/);
    expect(() => assertSafeDestructiveHome(os.homedir())).toThrow(/user home directory/);
    expect(() => assertSafeDestructiveHome(process.cwd())).toThrow(/current working directory/);
  });

  it("rejects symlink homes before recursive deletion", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-instance-safety-"));
    const target = path.join(root, "target");
    const link = path.join(root, "link");
    fs.mkdirSync(target);
    fs.symlinkSync(target, link);

    expect(() => assertSafeDestructiveHome(link)).toThrow(/symlink/);
  });

  it("rejects registry homes outside the canonical instance path", () => {
    const poisoned = instance("atlas", path.join(os.tmpdir(), "atlas"));

    expect(() => assertSafeManagedInstanceHome(poisoned)).toThrow(/one local instance/);
  });

  it("accepts only the canonical Cuttlefish home convention", () => {
    const managed = instance("cuttlefish", path.join(os.homedir(), ".cuttlefish"));

    expect(assertSafeManagedInstanceHome(managed)).toBe(path.join(os.homedir(), ".cuttlefish"));
  });

  it("rejects non-canonical names instead of mapping them to any home", async () => {
    const { homeForInstance } = await import("../../shared/instance-home.js");
    const upstreamName = ["ji", "nn"].join("");

    expect(() => homeForInstance(upstreamName)).toThrow(/one local instance/);
  });
});
