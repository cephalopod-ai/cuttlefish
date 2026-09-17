import { beforeEach, describe, expect, it, vi } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

withStaticTempCuttlefishHome("cuttlefish-setup-regression-");

// No engine, provider or optional npx process is needed for this setup contract.
vi.mock("../../shared/resolve-bin.js", () => ({
  isInstalled: vi.fn(() => false), resolveBin: vi.fn((name: string) => name),
}));
vi.mock("../../sessions/registry.js", () => ({ initDb: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: vi.fn((_file: unknown, _args: unknown, _options: unknown, callback: (err: Error) => void) => {
    callback(new Error("owned optional pre-cache failure"));
  }),
}));

const { initDb } = await import("../../sessions/registry.js");
const { runSetup } = await import("../setup.js");

beforeEach(() => {
  vi.mocked(initDb).mockReset();
});

describe("setup completion", () => {
  it("rejects essential registry failure before claiming completion", async () => {
    const failure = new Error("owned registry-open failure");
    vi.mocked(initDb).mockImplementationOnce(() => { throw failure; });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(runSetup()).rejects.toThrow("sessions database");
      expect(output.mock.calls.flat().join("\n")).not.toContain("Setup complete");
    } finally {
      output.mockRestore();
    }
  });

  it("completes despite unavailable engines and failed optional skills pre-cache", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(runSetup()).resolves.toBeUndefined();
      const text = output.mock.calls.flat().join("\n");
      expect(text).toContain("No AI engine CLI found");
      expect(text).toContain("Skills CLI pre-cache failed (non-fatal)");
      expect(text).toContain("Setup complete");
      expect(initDb).toHaveBeenCalledOnce();
    } finally {
      output.mockRestore();
    }
  });
});
