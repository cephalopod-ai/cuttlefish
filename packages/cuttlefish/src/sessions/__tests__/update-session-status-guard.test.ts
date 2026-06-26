import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

// Isolate the DB: CUTTLEFISH_HOME must be set before importing registry.
const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-status-guard-");
const reg = await import("../registry.js");

describe("updateSession status precondition guard (ST-001)", () => {
  it("accepts every legal lifecycle status", () => {
    reg.initDb();
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: "ok-ref" });
    for (const status of ["running", "waiting", "interrupted", "error", "idle"] as const) {
      const updated = reg.updateSession(s.id, { status });
      expect(updated?.status).toBe(status);
    }
  });

  it("rejects an illegal status string instead of persisting it", () => {
    reg.initDb();
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: "bad-ref" });
    // Cast through unknown to simulate a caller-supplied / API-body string.
    expect(() =>
      reg.updateSession(s.id, { status: "pwned" as unknown as never }),
    ).toThrow(/illegal session status/i);
    // The bogus write must not have landed; status is unchanged.
    expect(reg.getSession(s.id)?.status).not.toBe("pwned");
  });

  it("isValidSessionStatus discriminates known vs unknown states", () => {
    expect(reg.isValidSessionStatus("running")).toBe(true);
    expect(reg.isValidSessionStatus("done")).toBe(false);
    expect(reg.isValidSessionStatus(42)).toBe(false);
    expect(reg.isValidSessionStatus(undefined)).toBe(false);
  });
});
