import type { OrchestrationRuntime } from "../../orchestration/runtime.js";
import { runAllocatedDualLaneTask } from "../../orchestration/dual-lane.js";
import { runAllocatedOrchestrationTask } from "../../orchestration/run-mode.js";
import { interruptExpiredOrchestrationLeaseSessions } from "../api/session-dispatch.js";
import type { ApiContext } from "../api.js";

export function bindOrchestrationRuntimeHandlers(runtime: OrchestrationRuntime | undefined, apiContext: ApiContext): void {
  runtime?.setResumeQueuedRunHandler(async ({ continuation, allocation, reviewPolicy }) => {
    const result = continuation.mode === "dual_lane"
      ? await runAllocatedDualLaneTask({
        context: apiContext,
        task: continuation.task,
        allocation,
        reviewPolicy,
      })
      : await runAllocatedOrchestrationTask({
        context: apiContext,
        mode: continuation.mode,
        task: continuation.task,
        allocation,
        reviewPolicy,
      });
    if (!result.ok) {
      throw new Error(result.state === "failed"
        ? result.errorSummary
        : `unexpected orchestration state while resuming ${continuation.taskId}/${continuation.coordinatorId}: ${result.state}`);
    }
  });
  runtime?.setExpiredLeaseHandler((leases) => interruptExpiredOrchestrationLeaseSessions(apiContext, leases));
}
