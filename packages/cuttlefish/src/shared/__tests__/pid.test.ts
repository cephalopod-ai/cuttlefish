import { describe, it, expect, vi, afterEach } from "vitest";
import { probeProcess } from "../pid.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("probeProcess", () => {
  it("reports the current process as running", () => {
    expect(probeProcess(process.pid)).toBe("running");
  });

  it("treats an invalid (NaN) PID as indeterminate, not dead", () => {
    expect(probeProcess(NaN)).toBe("indeterminate");
  });

  it("treats a non-positive PID as indeterminate", () => {
    expect(probeProcess(0)).toBe("indeterminate");
    expect(probeProcess(-1)).toBe("indeterminate");
  });

  it("treats a non-integer PID as indeterminate", () => {
    expect(probeProcess(123.5)).toBe("indeterminate");
  });

  it("maps ESRCH to not-running", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("kill ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });
    expect(probeProcess(424242)).toBe("not-running");
  });

  it("maps EPERM to running (process exists but cannot be signaled) — never deletes underneath it", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("kill EPERM") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });
    expect(probeProcess(424242)).toBe("running");
  });

  it("maps an unexpected error code to indeterminate", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("kill EIO") as NodeJS.ErrnoException;
      err.code = "EIO";
      throw err;
    });
    expect(probeProcess(424242)).toBe("indeterminate");
  });
});
