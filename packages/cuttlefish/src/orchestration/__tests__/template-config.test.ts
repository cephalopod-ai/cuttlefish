import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadOrchestrationConfig } from "../config.js";
import { buildAllocationRequest } from "../schemas.js";
import { MatrixScheduler } from "../scheduler.js";

// The committed default config seeded into ~/.cuttlefish/orchestration/ by `cuttlefish setup`.
const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_ORCH_DIR = path.join(here, "..", "..", "..", "template", "orchestration");

describe("default orchestration template config", () => {
  const config = loadOrchestrationConfig(TEMPLATE_ORCH_DIR);

  it("parses the curated worker pool", () => {
    expect(config.workers.map((w) => w.id).sort()).toEqual([
      "antigravityReviewer",
      "claudeReviewer",
      "codexArchitect",
      "codexImplementer",
      "localWorker",
    ]);
  });

  it("staffs every coordinator template with distinct workers (no blocked roles)", () => {
    expect(config.coordinatorTemplates.length).toBeGreaterThan(0);

    for (const template of config.coordinatorTemplates) {
      // Fresh scheduler per template so leases/quotas from one team do not
      // bleed into the next — each team is evaluated against an empty pool.
      const scheduler = new MatrixScheduler(config);
      const request = buildAllocationRequest(
        {
          taskId: `task-${template.id}`,
          coordinatorId: `coord-${template.id}`,
          coordinatorTemplate: template.id,
        },
        config,
      );

      const result = scheduler.requestAllocation(request, { queueOnBlock: false });

      expect(
        result.ok,
        `coordinator template "${template.id}" could not be fully staffed`,
      ).toBe(true);
      if (!result.ok) continue;

      // Every required role must be present, each on its own distinct worker
      // (a worker capped at maxConcurrentTasks=1 cannot hold two roles at once).
      const rolesFilled = result.allocation.leases.map((lease) => lease.role);
      for (const role of template.requiredRoles) {
        expect(rolesFilled).toContain(role);
      }
      const singleSlotWorkerIds = result.allocation.leases
        .map((lease) => lease.workerId)
        .filter((id) => (config.workers.find((w) => w.id === id)?.maxConcurrentTasks ?? 1) === 1);
      expect(new Set(singleSlotWorkerIds).size).toBe(singleSlotWorkerIds.length);
    }
  });

  it("staffs the architectureChange team across three distinct families", () => {
    const scheduler = new MatrixScheduler(config);
    const request = buildAllocationRequest(
      { taskId: "task-arch", coordinatorId: "coord-arch", coordinatorTemplate: "architectureChange" },
      config,
    );

    const result = scheduler.requestAllocation(request, { queueOnBlock: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const families = new Set(
      result.allocation.leases.map(
        (lease) => config.workers.find((w) => w.id === lease.workerId)?.family,
      ),
    );
    // openai (implementer + architect), anthropic (independent), google (adversarial), local (qa)
    expect(families).toEqual(new Set(["openai", "anthropic", "google", "local"]));
  });
});
