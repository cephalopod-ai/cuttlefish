import { describe, it, expect } from "vitest";
import { buildHermesInteractiveArgs, isHermesTuiReady } from "../hermes-interactive.js";

describe("hermes interactive args", () => {
  it("uses classic REPL with full auto-approve", () => {
    expect(buildHermesInteractiveArgs()).toEqual(["chat", "--cli", "--yolo", "--accept-hooks"]);
  });
});

describe("isHermesTuiReady", () => {
  it("detects the REPL prompt", () => {
    expect(isHermesTuiReady("…\nhermes › ")).toBe(true);
    expect(isHermesTuiReady("loading…")).toBe(false);
  });
});
