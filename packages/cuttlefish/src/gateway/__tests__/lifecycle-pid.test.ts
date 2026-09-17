import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

withStaticTempCuttlefishHome("cuttlefish-lifecycle-pid-");
const { stop, getStatus, writeGatewayPid, clearGatewayPid, acquireRestartLock, RESTART_LOCK_FILE } = await import("../lifecycle.js");
const { PID_FILE } = await import("../../shared/paths.js");

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(PID_FILE, { force: true });
  fs.rmSync(RESTART_LOCK_FILE, { force: true });
});

describe("gateway PID admission", () => {
  it.each(["0", "-1", "123junk"])("recovers invalid restart owner %j without probing it", (contents) => {
    fs.writeFileSync(RESTART_LOCK_FILE, contents);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    expect(acquireRestartLock()).toBe(true);
    expect(kill).not.toHaveBeenCalled();
    expect(fs.readFileSync(RESTART_LOCK_FILE, "utf8").trim()).toBe(String(process.pid));
  });

  it.each(["0", "-1", "123junk", "NaN", "", "2147483648", "1.5"])("refuses invalid recorded identity %j without signalling", (contents) => {
    fs.writeFileSync(PID_FILE, contents);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);

    expect(stop(8891)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(fs.readFileSync(PID_FILE, "utf8")).toBe(contents);
    const status = getStatus(8891);
    expect(status.running).toBe(false);
    expect(status.pid).toBe(null);
    expect(status.error).toMatch(/invalid.*PID file/i);
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not clear a partially numeric PID file during foreground cleanup", () => {
    const contents = `${process.pid}junk`;
    fs.writeFileSync(PID_FILE, contents);
    clearGatewayPid();
    expect(fs.readFileSync(PID_FILE, "utf8")).toBe(contents);
  });

  it.each([0, -1, 1.5, Number.NaN, 2147483648])("rejects invalid explicit PID %j before writing", (pid) => {
    fs.writeFileSync(PID_FILE, "123");
    expect(() => writeGatewayPid(pid)).toThrow(/PID/);
    expect(fs.readFileSync(PID_FILE, "utf8")).toBe("123");
  });

  it("retains valid positive legacy PID and whitespace support", () => {
    fs.writeFileSync(PID_FILE, ` ${process.pid}\n`);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    expect(getStatus(8891)).toEqual({ running: true, pid: process.pid });
    expect(kill).toHaveBeenCalledWith(process.pid, 0);
    clearGatewayPid();
    expect(fs.existsSync(PID_FILE)).toBe(false);
  });
});
