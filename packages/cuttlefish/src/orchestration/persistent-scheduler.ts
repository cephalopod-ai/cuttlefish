import { MatrixScheduler, type AllocationRequestOptions, type SchedulerOptions } from "./scheduler.js";
import { OrchestrationStore } from "./store.js";
import type { Allocation, AllocationRequest, AllocationResult, Lease, LeaseValidationResult, OrchestrationConfig, QueueItem, SchedulerSnapshot, TelemetryEvent } from "./types.js";

export interface PersistentSchedulerOptions extends Omit<SchedulerOptions, "snapshot"> {
  dbPath?: string;
  store?: OrchestrationStore;
  expireOnHydrate?: boolean;
}

export class PersistentMatrixScheduler {
  private scheduler: MatrixScheduler;
  private readonly now: () => Date;
  private readonly ownsStore: boolean;
  private readonly schedulerOptions: Omit<SchedulerOptions, "snapshot" | "now">;

  constructor(
    private readonly config: OrchestrationConfig,
    private readonly store: OrchestrationStore,
    opts: PersistentSchedulerOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.ownsStore = !opts.store;
    this.schedulerOptions = {
      reviewPolicy: opts.reviewPolicy,
      workerScores: opts.workerScores,
      retention: opts.retention,
    };
    this.scheduler = this.hydrateScheduler();
    if (opts.expireOnHydrate !== false) {
      const before = this.scheduler.createSnapshot();
      const expired = this.scheduler.expireLeases(this.now());
      if (expired.length > 0) this.persistOrRehydrate(before);
    }
  }

  static open(config: OrchestrationConfig, opts: PersistentSchedulerOptions = {}): PersistentMatrixScheduler {
    const store = opts.store ?? OrchestrationStore.open(opts.dbPath);
    return new PersistentMatrixScheduler(config, store, opts);
  }

  close(): void {
    if (this.ownsStore) this.store.close();
  }

  requestAllocation(request: AllocationRequest, opts: AllocationRequestOptions = {}): AllocationResult {
    return this.commitMutation(() => this.scheduler.requestAllocation(request, opts));
  }

  tryAllocationNow(request: AllocationRequest, opts: AllocationRequestOptions = {}): AllocationResult {
    return this.commitMutation(() => this.scheduler.requestAllocation(request, { ...opts, queueOnBlock: false }));
  }

  heartbeatLease(leaseId: string, coordinatorId?: string): Lease {
    return this.commitMutation(() => this.scheduler.heartbeatLease(leaseId, coordinatorId));
  }

  releaseLease(leaseId: string, coordinatorId?: string): Lease {
    return this.commitMutation(() => this.scheduler.releaseLease(leaseId, coordinatorId));
  }

  expireLeases(now?: Date): Lease[] {
    return this.commitMutation(() => this.scheduler.expireLeases(now));
  }

  retryQueued(opts: AllocationRequestOptions = {}): AllocationResult[] {
    return this.commitMutation(() => this.scheduler.retryQueued(opts));
  }

  validateLeaseForWorker(workerId: string, leaseId: string, taskId: string, coordinatorId: string): LeaseValidationResult {
    return this.scheduler.validateLeaseForWorker(workerId, leaseId, taskId, coordinatorId);
  }

  listLeases(): Lease[] {
    return this.scheduler.listLeases();
  }

  listAllocations(): Allocation[] {
    return this.scheduler.listAllocations();
  }

  listQueue(): QueueItem[] {
    return this.scheduler.listQueue();
  }

  listTelemetry(): TelemetryEvent[] {
    return this.scheduler.listTelemetry();
  }

  createSnapshot(): SchedulerSnapshot {
    return this.scheduler.createSnapshot();
  }

  resolveLease(selector: { leaseId?: string; taskId?: string; role?: string; workerId?: string }): Lease {
    return this.scheduler.resolveLease(selector);
  }

  private commitMutation<T>(mutate: () => T): T {
    const before = this.scheduler.createSnapshot();
    const result = mutate();
    this.persistOrRehydrate(before);
    return result;
  }

  private persistOrRehydrate(before: SchedulerSnapshot): void {
    try {
      this.store.applySnapshotDelta(before, this.scheduler.createSnapshot());
    } catch (err) {
      this.scheduler = this.hydrateScheduler();
      throw err;
    }
  }

  private hydrateScheduler(): MatrixScheduler {
    return new MatrixScheduler(this.config, {
      now: this.now,
      ...this.schedulerOptions,
      snapshot: this.store.loadSnapshot(),
    });
  }
}
