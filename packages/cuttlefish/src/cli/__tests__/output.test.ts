import { describe, expect, it, vi } from "vitest";
import { printCliError } from "../output.js";

describe("printCliError", () => {
  it("prints a parseable JSON error on stdout for machine-readable commands", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      printCliError(new Error("Paired browser not found"), true);
      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({
        status: "error",
        message: "Paired browser not found",
      });
      expect(error).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      log.mockRestore();
      error.mockRestore();
    }
  });
});
