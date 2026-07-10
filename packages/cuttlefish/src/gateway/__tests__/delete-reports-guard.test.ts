import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import { createEmployeeYaml, deleteEmployeeYaml, scanOrg } from "../org.js";

const { home } = withStaticTempCuttlefishHome("cuttlefish-delete-guard-");

function seed(name: string, extra: Record<string, unknown> = {}) {
  return createEmployeeYaml({
    name, displayName: name, department: "eng", rank: "manager",
    engine: "claude", model: "opus", persona: "x", ...extra,
  } as any);
}

describe("deleteEmployeeYaml reports-guard (audit §7.2)", () => {
  beforeEach(() => {
    fs.rmSync(path.join(home, "org"), { recursive: true, force: true });
  });

  it("refuses to delete a manager who still has reports", () => {
    seed("boss");
    seed("worker", { rank: "employee", reportsTo: "boss" });
    expect(deleteEmployeeYaml("boss")).toBe(false); // guarded
    expect(scanOrg().has("boss")).toBe(true);
  });

  it("deletes an employee with no reports", () => {
    seed("lonely", { rank: "employee" });
    expect(deleteEmployeeYaml("lonely")).toBe(true);
    expect(scanOrg().has("lonely")).toBe(false);
  });
});
