import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

// Isolate the DB: CUTTLEFISH_HOME must be set before importing registry (SESSIONS_DB
// is resolved at module load).
const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-effort-");
const reg = await import("../registry.js");

describe("updateSession persists model + effort_level (mid-chat switch backing store)", () => {
  it("round-trips a model + effortLevel change", () => {
    reg.initDb();
    const s = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "test-ref",
      model: "opus",
      effortLevel: "medium",
    });
    expect(s.model).toBe("opus");
    expect(s.effortLevel).toBe("medium");

    const updated = reg.updateSession(s.id, { model: "claude-sonnet-4-6", effortLevel: "high" });
    expect(updated?.model).toBe("claude-sonnet-4-6");
    expect(updated?.effortLevel).toBe("high");

    // Persisted (what the next turn reads).
    const reloaded = reg.getSession(s.id);
    expect(reloaded?.model).toBe("claude-sonnet-4-6");
    expect(reloaded?.effortLevel).toBe("high");
  });
});
