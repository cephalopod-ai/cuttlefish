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
      this.expireLeases(this.now());
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
    return this.commitMutation((scheduler) => scheduler.requestAllocation(request, opts));
  }

  tryAllocationNow(request: AllocationRequest, opts: AllocationRequestOptions = {}): AllocationResult {
    return this.commitMutation((scheduler) => scheduler.requestAllocation(request, { ...opts, queueOnBlock: false }));
  }

  heartbeatLease(leaseId: string, coordinatorId?: string): Lease {
    return this.commitMutation((scheduler) => scheduler.heartbeatLease(leaseId, coordinatorId));
  }

  releaseLease(leaseId: string, coordinatorId?: string): Lease {
    return this.commitMutation((scheduler) => scheduler.releaseLease(leaseId, coordinatorId));
  }

  expireLeases(now?: Date): Lease[] {
    return this.commitMutation((scheduler) => scheduler.expireLeases(now));
  }

  retryQueued(opts: AllocationRequestOptions = {}): AllocationResult[] {
    return this.commitMutation((scheduler) => scheduler.retryQueued(opts));
  }

  validateLeaseForWorker(workerId: string, leaseId: string, taskId: string, coordinatorId: string): LeaseValidationResult {
    return this.refreshScheduler().validateLeaseForWorker(workerId, leaseId, taskId, coordinatorId);
  }

  listLeases(): Lease[] {
    return this.refreshScheduler().listLeases();
  }

  listAllocations(): Allocation[] {
    return this.refreshScheduler().listAllocations();
  }

  listQueue(): QueueItem[] {
    return this.refreshScheduler().listQueue();
  }

  listTelemetry(): TelemetryEvent[] {
    return this.refreshScheduler().listTelemetry();
  }

  createSnapshot(): SchedulerSnapshot {
    return this.refreshScheduler().createSnapshot();
  }

  resolveLease(selector: { leaseId?: string; taskId?: string; role?: string; workerId?: string }): Lease {
    return this.refreshScheduler().resolveLease(selector);
  }

  private commitMutation<T>(mutate: (scheduler: MatrixScheduler) => T): T {
    try {
      return this.store.transactionImmediate(() => {
        const scheduler = this.hydrateScheduler();
        const before = scheduler.createSnapshot();
        const result = mutate(scheduler);
        this.store.applySnapshotDelta(before, scheduler.createSnapshot());
        this.scheduler = scheduler;
        return result;
      });
    } catch (err) {
      this.scheduler = this.hydrateScheduler();
      throw err;
    }
  }

  private refreshScheduler(): MatrixScheduler {
    this.scheduler = this.hydrateScheduler();
    return this.scheduler;
  }

  private hydrateScheduler(): MatrixScheduler {
    return new MatrixScheduler(this.config, {
      now: this.now,
      ...this.schedulerOptions,
      snapshot: this.store.loadSnapshot(),
    });
  }
}
