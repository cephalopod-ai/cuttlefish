import { engineAvailable, type EngineName } from "../../shared/models.js";
import type {
  Engine,
  EngineFailureReason,
  EngineResult,
  CuttlefishConfig,
  ModelRegistry,
  StreamDelta,
} from "../../shared/types.js";
import { isInterruptibleEngine } from "../../shared/types.js";
import type { ProviderAdapter, ProviderAdapterError, ProviderArtifact, ProviderRun, ProviderRunStatus, ProviderStartTaskRequest } from "./types.js";
import {
  basicCapabilityCheck,
  providerFail,
  providerOk,
  runIdFor,
  unsupported,
  validateStartLease,
} from "./types.js";

const DEFAULT_MAX_RUNS = 100;
const CLAUDE_HEADLESS_FLAGS = new Set(["-p", "--print", "--json", "--headless", "--output-format"]);

export interface RealProviderAdapterOptions {
  id: EngineName;
  engines: ReadonlyMap<string, Engine>;
  getConfig: () => CuttlefishConfig;
  getModelRegistry?: () => ModelRegistry;
  isEngineAvailable?: (config: CuttlefishConfig, engine: EngineName) => boolean;
  now?: () => Date;
  maxRuns?: number;
}

interface RunRecord {
  run: ProviderRun;
  engine: Engine;
  subscribers: Set<(delta: StreamDelta) => void>;
  sequence: number;
}

export class RealProviderAdapter implements ProviderAdapter {
  readonly id: EngineName;
  private readonly now: () => Date;
  private readonly maxRuns: number;
  private readonly isEngineAvailable: (config: CuttlefishConfig, engine: EngineName) => boolean;
  private readonly runs = new Map<string, RunRecord>();
  private sequence = 0;

  constructor(private readonly opts: RealProviderAdapterOptions) {
    this.id = opts.id;
    this.now = opts.now ?? (() => new Date());
    this.maxRuns = Math.max(1, opts.maxRuns ?? DEFAULT_MAX_RUNS);
    this.isEngineAvailable = opts.isEngineAvailable ?? engineAvailable;
  }

  canExecute(request: Parameters<ProviderAdapter["canExecute"]>[0]) {
    const check = basicCapabilityCheck(request);
    const reasons = [...check.reasons];
    if (request.worker.provider !== this.id) reasons.push(`provider_mismatch:${request.worker.provider}`);
    if (!this.lookupEngine()) reasons.push(`engine_not_registered:${this.id}`);
    if (!this.isEngineAvailable(this.opts.getConfig(), this.id)) reasons.push(`engine_unavailable:${this.id}`);
    return providerOk({ canExecute: reasons.length === 0, reasons });
  }

  estimateCost(request: Parameters<ProviderAdapter["estimateCost"]>[0]) {
    return providerOk({
      costClass: request.worker.costClass,
      note: "real adapter delegates execution to the registered Cuttlefish engine without a live estimate call",
    });
  }

  estimateContext(request: Parameters<ProviderAdapter["estimateContext"]>[0]) {
    const registryEntry = this.opts.getModelRegistry?.()[this.id];
    const model = request.model ?? registryEntry?.models.find((entry) => entry.id === registryEntry.defaultModel) ?? registryEntry?.models[0];
    return providerOk({
      contextWindow: model?.contextWindow,
      promptChars: request.prompt?.length,
      note: "context estimate is resolved from local model metadata only",
    });
  }

  async startTask(request: ProviderStartTaskRequest) {
    const lease = await validateStartLease(request);
    if (!lease.ok) return lease;

    const requestError = this.validateRequest(request);
    if (requestError) return providerFail<ProviderRun>(requestError);

    const engine = this.lookupEngine();
    if (!engine || !this.isEngineAvailable(this.opts.getConfig(), this.id)) {
      return providerFail<ProviderRun>({
        code: "engine_unavailable",
        message: `engine ${this.id} is not available for worker ${request.worker.id}`,
        reason: this.id,
        detail: { workerId: request.worker.id, provider: request.worker.provider },
      });
    }

    const runId = runIdFor(this.id, request.lease.leaseId);
    const startedAt = this.now().toISOString();
    const initialRun: ProviderRun = {
      runId,
      adapterId: this.id,
      workerId: request.worker.id,
      leaseId: request.lease.leaseId,
      taskId: request.lease.taskId,
      status: "running",
      startedAt,
      engineSessionId: request.run.sessionId,
    };
    const record: RunRecord = {
      run: initialRun,
      engine,
      subscribers: new Set(),
      sequence: ++this.sequence,
    };
    this.runs.set(runId, record);
    this.pruneRuns();

    const upstreamStream = request.run.onStream;
    try {
      const result = await engine.run({
        ...request.run,
        onStream: (delta) => {
          upstreamStream?.(delta);
          this.broadcast(runId, delta);
        },
      });
      const current = this.runs.get(runId);
      if (!current) return providerOk(initialRun);
      if (current.run.status === "cancelled") return providerOk(current.run);

      if (result.error) {
        const error = engineFailedError(result.error, result);
        const failedRun = this.completeRun(current, {
          status: "failed",
          result,
          error,
        });
        return providerFail<ProviderRun>(errorWithRun(error, failedRun));
      }

      return providerOk(this.completeRun(current, { status: "completed", result }));
    } catch (err) {
      const current = this.runs.get(runId);
      if (current?.run.status === "cancelled") return providerOk(current.run);
      const error = engineFailedError(err instanceof Error ? err.message : String(err));
      if (current) this.completeRun(current, { status: "failed", error });
      return providerFail<ProviderRun>(error);
    }
  }

  async streamOutput(runId: string, onStream: (delta: StreamDelta) => void) {
    const record = this.runs.get(runId);
    if (!record) return unsupported<void>(`real adapter run not found: ${runId}`, { adapterId: this.id });
    if (record.run.status !== "running") {
      return providerFail<void>({
        code: "unsupported_operation",
        message: `cannot subscribe to terminal run ${runId}`,
        reason: record.run.status,
        detail: { adapterId: this.id, runId },
      });
    }
    record.subscribers.add(onStream);
    return providerOk(undefined);
  }

  async cancel(runId: string, reason?: string) {
    const record = this.runs.get(runId);
    if (!record || record.run.status !== "running") {
      return providerFail<void>({
        code: "cancel_not_supported",
        message: `cannot cancel run ${runId}`,
        reason: record ? record.run.status : "run_not_found",
        detail: { adapterId: this.id, runId },
      });
    }
    if (!record.run.engineSessionId) {
      return providerFail<void>({
        code: "invalid_request",
        message: `run ${runId} has no engine session id`,
        reason: "missing_session_id",
        detail: { adapterId: this.id, runId },
      });
    }
    if (!isInterruptibleEngine(record.engine)) {
      return providerFail<void>({
        code: "cancel_not_supported",
        message: `engine ${this.id} does not support interruption`,
        reason: this.id,
        detail: { adapterId: this.id, runId },
      });
    }

    try {
      record.engine.kill(record.run.engineSessionId, reason);
    } catch (err) {
      return providerFail<void>(engineFailedError(err instanceof Error ? err.message : String(err)));
    }

    this.completeRun(record, { status: "cancelled" });
    return providerOk(undefined);
  }

  async getStatus(runId: string) {
    const record = this.runs.get(runId);
    if (!record) return unsupported<ProviderRunStatus>(`real adapter run not found: ${runId}`, { adapterId: this.id });
    return providerOk(record.run.status);
  }

  async collectArtifacts(runId: string) {
    const record = this.runs.get(runId);
    if (!record) return unsupported<ProviderArtifact[]>(`real adapter run not found: ${runId}`, { adapterId: this.id });
    if (!record.run.result) return providerOk([]);
    const result = record.run.result;
    const artifact: ProviderArtifact = {
      id: `${runId}_engine_result`,
      kind: "metadata",
      label: "Engine result",
      content: result.result,
      metadata: {
        sessionId: result.sessionId,
        cost: result.cost,
        durationMs: result.durationMs,
        numTurns: result.numTurns,
        contextTokens: result.contextTokens,
        error: result.error,
        rateLimit: result.rateLimit,
      },
    };
    return providerOk([artifact]);
  }

  private lookupEngine(): Engine | undefined {
    return this.opts.engines.get(this.id);
  }

  private validateRequest(request: ProviderStartTaskRequest): ProviderAdapterError | undefined {
    if (request.worker.provider !== this.id) {
      return {
        code: "invalid_request",
        message: `worker ${request.worker.id} is bound to ${request.worker.provider}, not ${this.id}`,
        reason: "provider_mismatch",
        detail: { workerId: request.worker.id, provider: request.worker.provider, adapterId: this.id },
      };
    }
    if (!request.run.sessionId) {
      return {
        code: "invalid_request",
        message: `real adapter ${this.id} requires EngineRunOpts.sessionId`,
        reason: "missing_session_id",
        detail: { workerId: request.worker.id, leaseId: request.lease.leaseId },
      };
    }
    if (this.id === "claude") {
      const flag = request.run.cliFlags?.find((candidate) => isClaudeHeadlessFlag(candidate));
      if (flag) {
        return {
          code: "invalid_request",
          message: `claude worker cannot use headless bypass flag ${flag}`,
          reason: "claude_headless_bypass",
          detail: { flag },
        };
      }
    }
    return undefined;
  }

  private broadcast(runId: string, delta: StreamDelta): void {
    const record = this.runs.get(runId);
    if (!record) return;
    for (const subscriber of record.subscribers) {
      try {
        subscriber(delta);
      } catch {
        // Subscriber failures must not tear down the engine run.
      }
    }
  }

  private completeRun(
    record: RunRecord,
    patch: Pick<ProviderRun, "status"> & Partial<Pick<ProviderRun, "result" | "error">>,
  ): ProviderRun {
    const completed: ProviderRun = {
      ...record.run,
      ...patch,
      completedAt: this.now().toISOString(),
    };
    record.run = completed;
    record.subscribers.clear();
    this.pruneRuns();
    return completed;
  }

  private pruneRuns(): void {
    const removable = [...this.runs.entries()]
      .filter(([, record]) => record.run.status !== "running")
      .sort((a, b) => a[1].sequence - b[1].sequence);
    while (this.runs.size > this.maxRuns && removable.length > 0) {
      const [runId, record] = removable.shift()!;
      record.subscribers.clear();
      this.runs.delete(runId);
    }
  }
}

export function createRealProviderAdapter(opts: RealProviderAdapterOptions): RealProviderAdapter {
  return new RealProviderAdapter(opts);
}

function isClaudeHeadlessFlag(flag: string): boolean {
  const normalized = flag.trim().toLowerCase();
  const key = normalized.includes("=") ? normalized.slice(0, normalized.indexOf("=")) : normalized;
  return CLAUDE_HEADLESS_FLAGS.has(key);
}

function engineFailedError(message: string, result?: EngineResult): ProviderAdapterError {
  return {
    code: "engine_failed",
    message,
    engineFailureReason: engineFailureReason(message, result),
    detail: result?.rateLimit ? { rateLimit: result.rateLimit } : undefined,
  };
}

function engineFailureReason(message: string, result?: EngineResult): EngineFailureReason {
  if (result?.rateLimit) return "rate_limit";
  const lower = message.toLowerCase();
  if (lower.includes("rate limit")) return "rate_limit";
  if (lower.includes("quota") || lower.includes("credit")) return "quota_exhausted";
  if (lower.includes("auth") || lower.includes("login")) return "auth_failure";
  if (lower.includes("context")) return "context_overflow";
  if (lower.includes("unavailable") || lower.includes("not found")) return "engine_unavailable";
  if (lower.includes("timeout")) return "timeout";
  return "unknown";
}

function errorWithRun(error: ProviderAdapterError, run: ProviderRun): ProviderAdapterError {
  return {
    ...error,
    detail: {
      ...error.detail,
      runId: run.runId,
      status: run.status,
    },
  };
}
