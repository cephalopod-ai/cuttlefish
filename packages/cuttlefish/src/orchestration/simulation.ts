import type { SimulationScenario } from "./config.js";
import type { OrchestrationConfig } from "./types.js";
import { MatrixScheduler, runSimulation } from "./scheduler.js";

/** Public simulations use logical time; installed engines and wall time are irrelevant. */
export function simulateScenario(config: OrchestrationConfig, scenario: SimulationScenario) {
  let now = new Date(scenario.startTime ?? 0);
  if (!Number.isFinite(now.getTime())) throw new Error("invalid simulation startTime");
  const scheduler = new MatrixScheduler(config, { now: () => new Date(now) });
  const steps = scenario.steps.map((step, index) => {
    if ("expire" in step) {
      const next = new Date(step.expire.now);
      if (!Number.isFinite(next.getTime()) || next < now) {
        throw new Error(`simulation step ${index + 1}: expiry time must be valid and cannot move backwards`);
      }
      now = next;
    }
    return { ...runSimulation(scheduler, [step])[0], step: index + 1 };
  });
  return { name: scenario.name, steps, leases: scheduler.listLeases(), queue: scheduler.listQueue() };
}
