import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const gatewayDir = path.resolve(import.meta.dirname, "..");

function readRoute(name: string): string {
  return fs.readFileSync(path.join(gatewayDir, "api", "routes", name), "utf8");
}

describe("router boundary contract (ARC-CUT-008)", () => {
  it("keeps org persistence and lifecycle primitives behind domain services", () => {
    const source = readRoute("org.ts");
    for (const forbidden of [
      "createEmployeeYaml(",
      "updateEmployeeYaml(",
      "deleteEmployeeWithBoardCleanup(",
      "writeMergedBoardPartial(",
      "applyOrgChange(",
      "createSession(",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    expect(source).toContain("createCrossRequest(");
    expect(source).toContain("updateDepartmentBoard(");
    expect(source).toContain("updateOrgEmployee(");
  });

  it("keeps session state machines and persistence behind domain services", () => {
    const source = readRoute("session-write.ts");
    for (const forbidden of [
      "createSession(",
      "updateSession(",
      "deleteSession(",
      "deleteSessionsWithBoardCleanup(",
      "enqueueQueueItem(",
      "killSessionEngines(",
      "validateSessionPatch(",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    expect(source).toContain("createSessionFromRequest(");
    expect(source).toContain("deleteSessionAndCleanup(");
    expect(source).toContain("patchSession(");
  });
});
