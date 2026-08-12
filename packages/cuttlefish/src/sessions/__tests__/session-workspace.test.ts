import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CUTTLEFISH_HOME } from "../../shared/paths.js";
import { resolveSessionWorkspace } from "../session-workspace.js";

describe("resolveSessionWorkspace", () => {
  it("keeps implicit engine workspaces outside the gateway control home", () => {
    const workspace = resolveSessionWorkspace({ id: "session/unsafe", cwd: null });

    expect(path.relative(CUTTLEFISH_HOME, workspace).startsWith("..")).toBe(true);
    expect(workspace).toContain("session_unsafe");
    expect(fs.statSync(workspace).isDirectory()).toBe(true);
  });

  it("preserves an explicit operator workspace", () => {
    expect(resolveSessionWorkspace({ id: "session-1", cwd: "/tmp/operator-project" })).toBe("/tmp/operator-project");
  });
});
