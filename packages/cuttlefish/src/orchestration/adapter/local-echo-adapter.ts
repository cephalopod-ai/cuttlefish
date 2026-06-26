import { MockEngine } from "../../engines/mock.js";
import type { Engine } from "../../shared/types.js";
import type { ProviderAdapter, ProviderRun, ProviderRunStatus, ProviderStartTaskRequest } from "./types.js";
import {
  basicCapabilityCheck,
  providerFail,
  providerOk,
  runIdFor,
  unsupported,
  validateStartLease,
} from "./types.js";

export interface LocalEchoAdapterOptions {
  id?: string;
  engine?: Engine;
  now?: () => Date;
}

export class LocalEchoProviderAdapter implements ProviderAdapter {
  readonly id: string;
  private readonly engine: Engine;
  private readonly now: () => Date;
  private readonly runs = new Map<string, ProviderRun>();

  constructor(opts: LocalEchoAdapterOptions = {}) {
    this.id = opts.id ?? "local_echo";
    this.engine = opts.engine ?? new MockEngine();
    this.now = opts.now ?? (() => new Date());
  }

  canExecute(request: Parameters<ProviderAdapter["canExecute"]>[0]) {
    return providerOk(basicCapabilityCheck(request));
  }

  estimateCost(request: Parameters<ProviderAdapter["estimateCost"]>[0]) {
    return providerOk({
      costClass: request.worker.costClass,
      estimatedUsd: 0.001,
      note: "local echo uses the deterministic MockEngine",
    });
  }

  estimateContext(request: Parameters<ProviderAdapter["estimateContext"]>[0]) {
    return providerOk({
      contextWindow: request.model?.contextWindow,
      promptChars: request.prompt?.length,
      note: "local echo does not estimate provider-side context",
    });
  }

  async startTask(request: ProviderStartTaskRequest) {
    const lease = await validateStartLease(request);
    if (!lease.ok) return lease;

    const runId = runIdFor(this.id, request.lease.leaseId);
    const startedAt = this.now().toISOString();
    this.runs.set(runId, {
      runId,
      adapterId: this.id,
      workerId: request.worker.id,
      leaseId: request.lease.leaseId,
      taskId: request.lease.taskId,
      status: "running",
      startedAt,
    });

    try {
      const result = await this.engine.run(request.run);
      if (result.error) {
        const error = {
          code: "engine_failed" as const,
          message: result.error,
          engineFailureReason: "unknown" as const,
        };
        this.runs.set(runId, {
          ...this.runs.get(runId)!,
          status: "failed",
          completedAt: this.now().toISOString(),
          result,
          error,
        });
        return providerFail<ProviderRun>(error);
      }
      const run: ProviderRun = {
        ...this.runs.get(runId)!,
        status: "completed",
        completedAt: this.now().toISOString(),
        engineSessionId: result.sessionId,
        result,
      };
      this.runs.set(runId, run);
      return providerOk(run);
    } catch (err) {
      const error = {
        code: "engine_failed" as const,
        message: err instanceof Error ? err.message : String(err),
        engineFailureReason: "unknown" as const,
      };
      this.runs.set(runId, {
        ...this.runs.get(runId)!,
        status: "failed",
        completedAt: this.now().toISOString(),
        error,
      });
      return providerFail<ProviderRun>(error);
    }
  }

  async streamOutput() {
    return unsupported<void>("local echo streams through startTask run options", { adapterId: this.id });
  }

  async cancel(runId: string) {
    const run = this.runs.get(runId);
    if (!run || run.status !== "running") {
      return providerFail<void>({
        code: "cancel_not_supported",
        message: `cannot cancel local echo run ${runId}`,
        reason: run ? run.status : "run_not_found",
      });
    }
    run.status = "cancelled";
    run.completedAt = this.now().toISOString();
    return providerOk(undefined);
  }

  async getStatus(runId: string) {
    const run = this.runs.get(runId);
    if (!run) return unsupported<ProviderRunStatus>(`local echo run not found: ${runId}`, { adapterId: this.id });
    return providerOk(run.status);
  }

  async collectArtifacts(runId: string) {
    const run = this.runs.get(runId);
    if (!run) return unsupported<[]>(`local echo run not found: ${runId}`, { adapterId: this.id });
    return providerOk([]);
  }
}

export function createLocalEchoAdapter(opts: LocalEchoAdapterOptions = {}): LocalEchoProviderAdapter {
  return new LocalEchoProviderAdapter(opts);
}
