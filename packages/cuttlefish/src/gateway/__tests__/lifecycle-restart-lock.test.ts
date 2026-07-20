import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

const spawn = vi.hoisted(() => vi.fn(() => ({ pid: process.pid, unref: vi.fn() })));
const execFileSync = vi.hoisted(() => vi.fn(() => "v24.13.0\n"));

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFileSync,
  spawn,
}));

const { home } = withStaticTempCuttlefishHome("cuttlefish-restart-lock-");
const { RESTART_LOCK_FILE, restartDetached, releaseRestartLock } = await import("../lifecycle.js");

describe("detached restart lock", () => {
  afterEach(() => {
    releaseRestartLock();
    fs.rmSync(home, { recursive: true, force: true });
    spawn.mockClear();
  });

  it("coalesces a second restart request until the first helper releases its lock", () => {
    expect(restartDetached()).toBe(true);
    expect(restartDetached()).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(RESTART_LOCK_FILE, "utf8").trim()).toBe(String(process.pid));
  });
});
