# Feature Ledger: prefork-common-stages2-7

**feature id:** `prefork-common-stages2-7`

## Stages 2-7: Fail-Closed Recovery, Artifact Lineage, Policy, Export Gate, Inspect

**action summary:** Complete the pre-fork common substrate plan: boot-time orphan recovery, artifact-lineage DB, rights/retention policy evaluators, policy file hierarchy, export constraint gate, and minimal inspection surfaces (HTTP routes + CLI).

**status:** complete (pending CI validation)

## Stage 2: Fail-Closed Recovery

**touched files:**
- `packages/cuttlefish/src/shared/run-recovery.ts` — `recoverOrphanedRunsAtStartup()` boot-time sweep; fail-closed (only → `interrupted`)
- `packages/cuttlefish/src/gateway/server.ts` — call `recoverOrphanedRunsAtStartup` at boot after session recovery
- `packages/cuttlefish/src/cli/ledger.ts` — `runLedgerStatus()`, `runLedgerReset()` with quarantine

## Stage 3: Artifact-Lineage Database

**touched files:**
- `packages/cuttlefish/src/artifact-lineage/types.ts` — Zod schemas and input types
- `packages/cuttlefish/src/artifact-lineage/store.ts` — `ArtifactLineageStore` (WAL SQLite, DAG cycle detection, quarantine)
- `packages/cuttlefish/src/artifact-lineage/index.ts` — singleton `getArtifactLineage()`, `resetArtifactLineageForTest()`
- `packages/cuttlefish/src/artifact-lineage/__tests__/store.test.ts` — unit tests (register, edges, quarantine, xrefs)
- `packages/cuttlefish/src/sessions/registry/files.ts` — `insertFile()` calls `getArtifactLineage().registerArtifact()` (try/catch, non-fatal)
- `packages/cuttlefish/src/orchestration/artifacts.ts` — `writeArtifact()` calls `getArtifactLineage().registerArtifact()` (try/catch, non-fatal)

## Stage 4: Rights and Retention Evaluators

**touched files:**
- `packages/cuttlefish/src/policy/types.ts` — `PolicyArtifactDescriptor`, `PolicyEvalContext`, `PolicyVerdict`, `PolicyRule`, `PolicyProfile`
- `packages/cuttlefish/src/policy/evaluator.ts` — `evaluatePolicy()` (first-match rule wins; default deny for export/quarantine, allow for retain/register)
- `packages/cuttlefish/src/policy/profiles.ts` — `buildDefaultProfile()`, `buildStrictExportProfile()`

## Stage 5: Policy File Hierarchy and Module Registry

**touched files:**
- `packages/cuttlefish/src/policy/loader.ts` — `loadPolicyProfile()`, `getPolicyProfile()` (JSON files from POLICY_DIR; cache)
- `packages/cuttlefish/src/shared/config-schema.ts` — added `policy` section (`policy.dir` string)

## Stage 6: Thin Release/Export Constraint Layer

**touched files:**
- `packages/cuttlefish/src/policy/export-gate.ts` — `gateExternalEmit()`, `gateArtifactRegister()` (built-in rules: allow knowledge:*, deny cuttlefish.run_bundle*)
- `packages/cuttlefish/src/gateway/run-bundles.ts` — `exportRunBundle()` calls `gateExternalEmit()` before `copyArtifacts`; throws if denied
- `packages/cuttlefish/src/knowledge/outbox-service.ts` — `enqueueKnowledgeEnvelope()` calls `gateExternalEmit()`; logs warn + returns null if denied

## Stage 7: Minimal Inspection Surfaces

**touched files:**
- `packages/cuttlefish/src/gateway/api/routes/inspect.ts` — `handleInspectRoutes()`: GET /api/inspect/runs, /api/inspect/runs/:runId, /api/inspect/lineage/:artifactId, /api/inspect/dead-letter, /api/inspect/policy
- `packages/cuttlefish/src/gateway/api.ts` — registers `handleInspectRoutes`
- `packages/cuttlefish/src/cli/inspect.ts` — CLI commands: `runInspectRuns`, `runInspectRun`, `runInspectLineage`, `runInspectDeadLetter`, `runInspectPolicy`
- `packages/cuttlefish/bin/cuttlefish.ts` — `inspect` subcommand group (runs, run, lineage, dead-letter, policy)

## Validation Run

- `tsc --noEmit -p packages/cuttlefish/tsconfig.json`: only pre-existing infrastructure errors (missing node_modules/types); no new type errors in changed files
- Domain drift guard (DAWES): CLEAN
- `pnpm test` / `pnpm typecheck`: blocked by Node.js 22 vs required Node.js 24 (engine-strict=true); CI environment required for full validation

## Remaining Open Items

- Full CI validation (`pnpm test`, `pnpm typecheck`, `pnpm lint`) requires Node.js 24
- Tests for Stage 1-B run-ledger integration (`orchestration/__tests__/run-ledger-integration.test.ts`) not yet written
- Tests for Stage 2 recovery (`shared/__tests__/run-recovery.test.ts`) not yet written
- Documentation updates (ARCHITECTURE.md, SPECIFICATION.md, feature_inventory.md, TEST_LEDGER.md) not yet written

## Provenance

Implementation of stages 2-7 of the pre-fork common substrate plan, 2026-06-30. Files read and verified before modification. Domain drift guard passed.
