import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSync = vi.hoisted(() => vi.fn(() => ({ status: 0 })));

vi.mock("node:child_process", () => ({
  spawnSync,
}));

import { runNpxSkills } from "../skills.js";

const REAL_PLATFORM = Object.getOwnPropertyDescriptor(process, "platform")!;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform });
}

describe("skills CLI process spawning", () => {
  afterEach(() => {
    Object.defineProperty(process, "platform", REAL_PLATFORM);
    spawnSync.mockClear();
  });

  it("passes user-controlled skill args as argv with shell disabled", () => {
    setPlatform("linux");
    runNpxSkills(["add", "owner/repo; touch /tmp/pwned", "-g", "-y"], "pipe");

    expect(spawnSync).toHaveBeenCalledWith(
      "npx",
      ["skills", "add", "owner/repo; touch /tmp/pwned", "-g", "-y"],
      { stdio: "pipe", shell: false },
    );
  });

  it("on Windows, runs the npx.cmd shim through the shell with allowlisted args", () => {
    setPlatform("win32");
    runNpxSkills(["add", "owner/repo@skill-name", "-g", "-y"], "pipe");

    expect(spawnSync).toHaveBeenCalledWith(
      "npx.cmd",
      ["skills", "add", "owner/repo@skill-name", "-g", "-y"],
      { stdio: "pipe", shell: true },
    );
  });

  it("on Windows, refuses args with cmd metacharacters instead of spawning a shell", () => {
    setPlatform("win32");
    const result = runNpxSkills(["add", "owner/repo & calc.exe", "-g", "-y"], "pipe");

    expect(spawnSync).not.toHaveBeenCalled();
    expect(result.status).toBe(1);
    expect(result.error?.message).toContain("shell metacharacters");
  });
});
