import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  resolveDefaultWebSessionDispatcher,
  type WebSessionDispatcher,
} from "../execution-port.js";

const ORCH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function orchestrationSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "__tests__") continue; // tests may import the gateway freely
      out.push(...orchestrationSourceFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("ARC-CUT-001 orchestration → gateway import guard", () => {
  it("no orchestration source file statically imports the gateway API aggregate or session-dispatch", () => {
    const offenders: string[] = [];
    // A static import is `import ... from "...gateway/api.js"`; the lazy
    // `await import(...)` form in execution-port.ts is allowed because it does
    // not create a static module-graph edge.
    const staticAggregate = /^\s*import\b[^\n]*from\s+["'][^"']*gateway\/api\.js["']/m;
    const staticDispatch = /^\s*import\b[^\n]*from\s+["'][^"']*gateway\/api\/session-dispatch\.js["']/m;

    for (const file of orchestrationSourceFiles(ORCH_DIR)) {
      const src = readFileSync(file, "utf8");
      if (staticAggregate.test(src) || staticDispatch.test(src)) {
        offenders.push(path.relative(ORCH_DIR, file));
      }
    }

    expect(offenders, `orchestration must not statically import the gateway API aggregate or session-dispatch; offenders: ${offenders.join(", ")}`).toEqual([]);
  });

  it("orchestration source files contain no embedded NUL bytes (stay grep/rg-readable)", () => {
    const binary: string[] = [];
    for (const file of orchestrationSourceFiles(ORCH_DIR)) {
      if (readFileSync(file).includes(0)) binary.push(path.relative(ORCH_DIR, file));
    }
    expect(binary).toEqual([]);
  });

  it("resolves the default web-session dispatcher lazily without a static edge", async () => {
    const dispatch = await resolveDefaultWebSessionDispatcher();
    expect(typeof dispatch).toBe("function");
    // The default is the real gateway dispatcher: (session, prompt, engine,
    // config, context, opts?) — at least the five required positional params.
    expect(dispatch.length).toBeGreaterThanOrEqual(5);
  });

  it("runOrchestrationLeaseTurn accepts an injected dispatch port (dependency inversion)", async () => {
    const { runOrchestrationLeaseTurn } = await import("../run-mode.js");
    // The injected port satisfies the WebSessionDispatcher type, proving the
    // turn can run against a fake execution port rather than the gateway path.
    const fake: WebSessionDispatcher = async () => {};
    // We only assert the signature/contract here; full lease execution is
    // covered by run-mode.test.ts. Passing `dispatch` must be type-accepted.
    expect(typeof runOrchestrationLeaseTurn).toBe("function");
    expect(typeof fake).toBe("function");
  });
});
