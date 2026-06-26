import type { ProviderAdapter, ProviderRun, ProviderStartTaskRequest } from "./types.js";
import {
  basicCapabilityCheck,
  providerOk,
  unsupported,
  validateStartLease,
} from "./types.js";

export class StubProviderAdapter implements ProviderAdapter {
  constructor(readonly id = "stub") {}

  canExecute(request: Parameters<ProviderAdapter["canExecute"]>[0]) {
    return providerOk(basicCapabilityCheck(request));
  }

  estimateCost(request: Parameters<ProviderAdapter["estimateCost"]>[0]) {
    return providerOk({
      costClass: request.worker.costClass,
      note: "stub adapter does not execute tasks",
    });
  }

  estimateContext(request: Parameters<ProviderAdapter["estimateContext"]>[0]) {
    return providerOk({
      contextWindow: request.model?.contextWindow,
      promptChars: request.prompt?.length,
      note: "stub adapter does not execute tasks",
    });
  }

  async startTask(request: ProviderStartTaskRequest) {
    const lease = await validateStartLease(request);
    if (!lease.ok) return lease;
    return unsupported<ProviderRun>("stub adapter cannot start tasks", { adapterId: this.id });
  }

  async streamOutput() {
    return unsupported<void>("stub adapter has no output stream", { adapterId: this.id });
  }

  async cancel() {
    return unsupported<void>("stub adapter has no running task to cancel", { adapterId: this.id });
  }

  async getStatus() {
    return unsupported<"failed">("stub adapter has no run status", { adapterId: this.id });
  }

  async collectArtifacts() {
    return unsupported<[]>("stub adapter has no artifacts", { adapterId: this.id });
  }
}

export function createStubAdapter(id = "stub"): StubProviderAdapter {
  return new StubProviderAdapter(id);
}
