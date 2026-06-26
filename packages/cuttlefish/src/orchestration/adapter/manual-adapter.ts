import type { ProviderAdapter, ProviderRun, ProviderStartTaskRequest } from "./types.js";
import {
  basicCapabilityCheck,
  providerFail,
  providerOk,
  unsupported,
  validateStartLease,
} from "./types.js";

export class ManualProviderAdapter implements ProviderAdapter {
  constructor(readonly id = "manual") {}

  canExecute(request: Parameters<ProviderAdapter["canExecute"]>[0]) {
    return providerOk(basicCapabilityCheck(request));
  }

  estimateCost(request: Parameters<ProviderAdapter["estimateCost"]>[0]) {
    return providerOk({
      costClass: request.worker.costClass,
      note: "manual adapter requires an operator outside M2",
    });
  }

  estimateContext(request: Parameters<ProviderAdapter["estimateContext"]>[0]) {
    return providerOk({
      contextWindow: request.model?.contextWindow,
      promptChars: request.prompt?.length,
      note: "manual adapter does not run a model in M2",
    });
  }

  async startTask(request: ProviderStartTaskRequest) {
    const lease = await validateStartLease(request);
    if (!lease.ok) return lease;
    return providerFail<ProviderRun>({
      code: "manual_required",
      message: "manual adapter requires human execution outside M2",
      reason: "manual_required",
      detail: {
        adapterId: this.id,
        leaseId: request.lease.leaseId,
        taskId: request.lease.taskId,
      },
    });
  }

  async streamOutput() {
    return unsupported<void>("manual adapter has no output stream in M2", { adapterId: this.id });
  }

  async cancel() {
    return unsupported<void>("manual adapter has no running task to cancel in M2", { adapterId: this.id });
  }

  async getStatus() {
    return providerOk<"manual_required">("manual_required");
  }

  async collectArtifacts() {
    return providerOk([]);
  }
}

export function createManualAdapter(id = "manual"): ManualProviderAdapter {
  return new ManualProviderAdapter(id);
}
