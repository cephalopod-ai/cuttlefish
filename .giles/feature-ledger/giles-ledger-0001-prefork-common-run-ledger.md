# Feature Ledger: prefork-common-run-ledger

**feature id:** `prefork-common-run-ledger`

## Stage 1-B: Orchestration Run-Ledger Routing + Reset Migration

**action summary:** Wire orchestration allocations through the canonical run-ledger (per-allocation granularity), add run_id column to live_run_continuations, add boot-time orphan sweep, and add migrate subcommand for schema reset.

**status:** in-progress

**touched files:**
- `packages/cuttlefish/src/orchestration/run-mode.ts` — add `beginOrchestrationRun`, finalize on completed/failed
- `packages/cuttlefish/src/orchestration/dual-lane.ts` — add orchestration run-ledger integration
- `packages/cuttlefish/src/orchestration/runtime.ts` — update `recoverStaleDispatchingContinuations`, `prepareForShutdown`, add boot-time orphan sweep
- `packages/cuttlefish/src/orchestration/store-schema.ts` — add `run_id` column to `live_run_continuations`
- `packages/cuttlefish/src/orchestration/store-continuations.ts` — expose run_id on records
- `packages/cuttlefish/src/orchestration/types.ts` — add `runId` to `Allocation`
- `packages/cuttlefish/src/orchestration/__tests__/run-ledger-integration.test.ts` — new test file
- `packages/cuttlefish/src/shared/paths.ts` — add `ARTIFACT_LINEAGE_DB`, `POLICY_DIR`
- `packages/cuttlefish/bin/cuttlefish.ts` — add `migrate` subcommand

**validation run:** pending
**remaining open items:** Stage 2-7 (artifact-lineage, recovery, policy, export-gate, inspect routes)
**provenance:** initial implementation per plan document, 2026-06-30
