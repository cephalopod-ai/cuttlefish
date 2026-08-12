import { describe, expect, it, vi } from "vitest";
import { skillsFind } from "../skills.js";

describe("skillsFind", () => {
  it.each([undefined, "", "   "])("rejects an empty query before spawning (%j)", (query) => {
    const runFinder = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      skillsFind(query, { runFinder });
      expect(runFinder).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith("Usage: cuttlefish skills find <query>");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      error.mockRestore();
    }
  });

  it("trims and forwards a non-empty query", () => {
    const runFinder = vi.fn(() => ({ status: 0 }) as any);
    skillsFind("  security audit  ", { runFinder });
    expect(runFinder).toHaveBeenCalledWith(["find", "security audit"]);
  });
});
