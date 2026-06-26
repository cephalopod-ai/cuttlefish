import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-transport-meta-");
const reg = await import("../registry.js");

describe("patchSessionTransportMeta", () => {
  it("merges against the latest stored transportMeta", () => {
    reg.initDb();
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "meta",
      transportMeta: { a: "1" },
    });

    reg.patchSessionTransportMeta(session.id, { b: "2" });
    const updated = reg.patchSessionTransportMeta(session.id, (current) => ({ ...current, c: "3" }));

    expect(updated?.transportMeta).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("returns undefined for a missing session", () => {
    reg.initDb();
    expect(reg.patchSessionTransportMeta("missing", { b: "2" })).toBeUndefined();
  });
});
