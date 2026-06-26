import { describe, it, expect, beforeAll } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the DB at a throwaway dir BEFORE importing the registry (SESSIONS_DB is
// resolved from CUTTLEFISH_HOME at module load).
const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-pe-");

type Reg = typeof import("../registry.js");
let reg: Reg;

beforeAll(async () => {
  reg = await import("../registry.js");
  reg.initDb();
});

const base = { engine: "claude", source: "web", sourceRef: "web:pe" } as const;

describe("createSession promptExcerpt override", () => {
  it("uses the override instead of the (scaffolded) prompt and persists it", () => {
    const s = reg.createSession({
      ...base,
      prompt: 'Brief…\n\n---\nOperator\'s original request (verbatim): "fix the build"',
      promptExcerpt: "fix the build",
    });
    expect(s.promptExcerpt).toBe("fix the build");
    expect(reg.getSession(s.id)?.promptExcerpt).toBe("fix the build");
  });

  it("still flattens and truncates the override like a prompt", () => {
    const long = ("alpha beta\ngamma ").repeat(12); // multi-line, >140 chars flat
    const s = reg.createSession({ ...base, prompt: "scaffold", promptExcerpt: long });
    expect(s.promptExcerpt).not.toMatch(/\n/);
    expect(s.promptExcerpt!.length).toBeLessThanOrEqual(140);
    expect(s.promptExcerpt!.endsWith("…")).toBe(true);
  });

  it("falls back to the prompt excerpt when no override is given", () => {
    const s = reg.createSession({ ...base, prompt: "plain prompt" });
    expect(s.promptExcerpt).toBe("plain prompt");
  });

  it("falls back to the prompt excerpt when the override is blank", () => {
    const s = reg.createSession({ ...base, prompt: "plain prompt", promptExcerpt: "   " });
    expect(s.promptExcerpt).toBe("plain prompt");
  });
});
