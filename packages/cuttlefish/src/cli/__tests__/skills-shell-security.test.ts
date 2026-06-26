import { describe, expect, it, vi } from "vitest";

const spawnSync = vi.hoisted(() => vi.fn(() => ({ status: 0 })));

vi.mock("node:child_process", () => ({
  spawnSync,
}));

import { runNpxSkills } from "../skills.js";

describe("skills CLI process spawning", () => {
  it("passes user-controlled skill args as argv with shell disabled", () => {
    runNpxSkills(["add", "owner/repo; touch /tmp/pwned", "-g", "-y"], "pipe");

    expect(spawnSync).toHaveBeenCalledWith(
      "npx",
      ["skills", "add", "owner/repo; touch /tmp/pwned", "-g", "-y"],
      { stdio: "pipe", shell: false },
    );
  });
});
