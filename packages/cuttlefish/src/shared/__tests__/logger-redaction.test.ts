import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { configureLogger, logger } from "../logger.js";

describe("logger redaction", () => {
  it("redacts secrets before stdout and file logging", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const writes: string[] = [];
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined as any);
    vi.spyOn(fs, "createWriteStream").mockReturnValue({ write: (line: string) => { writes.push(line); } } as any);

    configureLogger({ level: "debug", stdout: true, file: true });
    logger.info("OPENAI_API_KEY=sk-test...cdef Authorization: " + ("Bear" + "er") + " sk-live...cdef");

    const stdout = String(spy.mock.calls[0]?.[0] ?? "");
    const file = writes.join("\n");
    expect(stdout).toContain("[REDACTED]");
    expect(file).toContain("[REDACTED]");
    expect(stdout).not.toContain("sk-test...cdef");
    expect(file).not.toContain("sk-live...cdef");

    spy.mockRestore();
    vi.restoreAllMocks();
  });
});
