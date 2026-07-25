# Feature ledger - branch/PR consolidation and js-yaml v5 repair (2026-07-25)

- **Feature id:** `branch-pr-consolidation-2026-07-25`
- **Action summary:** Operator asked to resolve all branches to main, deconflict,
  handle open pull requests, sync, then cut a release. Local `main` was 6
  commits ahead of `origin/main` with no divergence (fast-forward push only,
  no conflict). Found 6 open Dependabot PRs (#52-#57); all failed a repo-wide
  "Run Gitleaks Scan" check due to a missing `GITLEAKS_LICENSE` org secret
  (pre-existing infra gap, unrelated to any PR content, left open for the
  operator to fix separately). PR #54 (`js-yaml` 4.3.0 -> 5.2.2) additionally
  failed real unit tests: js-yaml v5 dropped its CommonJS default export in
  favor of named exports only, so this repo's `import yaml from "js-yaml"`
  pattern silently resolved `yaml` to `undefined`, breaking every
  `yaml.load`/`yaml.dump` call site at runtime (`TypeError: Cannot read
  properties of undefined (reading 'load')`), including live org/employee
  YAML parsing (`gateway/org.ts`) and config read/write
  (`shared/config.ts`). Fixed by switching all 16 call sites from default to
  namespace imports (`import * as yaml from "js-yaml"`), which is
  interop-safe under this repo's `esModuleInterop`/`NodeNext` TS config and
  requires no call-site changes. Merged PRs #52
  (`actions/checkout` 7.0.0->7.0.1), #53 (npm-minor-and-patch group, 15
  updates), #55 (`lucide-react` 0.577.0->1.26.0), #56 (`vite`
  7.3.6->8.1.5), #57 (`better-sqlite3` 12.11.1->13.0.1) as-is after
  confirming build/typecheck/e2e/unit-tests green on each (only the known
  Gitleaks license gap failing). #53's GitHub-side `mergeable` computation
  stuck at `UNKNOWN` for several minutes after #52 landed; unblocked by
  checking out the PR branch locally, merging latest `main` in (clean,
  verified via `git merge-tree` first), and pushing that back to the PR
  branch to force GitHub to recompute. #54 required the js-yaml fix above
  before merging.
- **Touched files:** `packages/cuttlefish/src/shared/safe-write.ts`,
  `shared/config.ts`, `shared/version.ts`,
  `shared/__tests__/config.test.ts`, `cli/orchestration.ts`, `cli/setup.ts`,
  `cli/migrate.ts`, `orchestration/config.ts`, `orchestration/coordinator.ts`,
  `gateway/org-changes.ts`, `gateway/org.ts`,
  `gateway/__tests__/config-put-roundtrip.test.ts`,
  `gateway/__tests__/org-department-rename-route.test.ts`,
  `gateway/__tests__/org-update.test.ts`,
  `gateway/api/routes/system.ts`, `talk/routes.ts` (all: default -> namespace
  import of `js-yaml`); `pnpm-lock.yaml`, `packages/cuttlefish/package.json`,
  `packages/web/package.json`, root `package.json` (dependency bumps from
  PRs #53/#55/#56/#57); `.github/workflows/*.yml` (PR #52's
  `actions/checkout` bump); this ledger.
- **Validation run:** Per-file `git merge-tree` dry runs before every merge
  (no conflict markers). After the js-yaml fix: `pnpm typecheck` passed
  (cuttlefish-cli); `pnpm test` passed (309 test files, 2,527 tests passed /
  1 skipped, including the two previously-red suites
  `gateway/__tests__/leader-ack-reconciler.test.ts` and
  `gateway/__tests__/ticket-dispatch-orchestration.test.ts`); `pnpm build`
  passed for both workspace packages; runtime sanity check of
  `yaml.dump`/`yaml.load` under the new import shape confirmed working
  standalone. Each merged PR's own CI (build, e2e, typecheck, unit-tests)
  was confirmed green before merge; only Gitleaks failed, uniformly, for a
  documented pre-existing reason.
- **Remaining open items:** `GITLEAKS_LICENSE` GitHub secret is missing at
  the org level (`cephalopod-ai`), so the Gitleaks Scan check will continue
  to fail on every PR/push until an operator with org admin access adds it
  (see gitleaks.io for a license, or disable/adjust the workflow if the org
  no longer wants gated secret scanning). GitHub also flagged 3 high +
  moderate Dependabot vulnerability alerts on `main` after these pushes
  (surfaced in `git push` remote messages) — not yet triaged as part of this
  ledger entry; check `https://github.com/cephalopod-ai/cuttlefish/security/dependabot`.
- **Provenance:** Direct operator request on 2026-07-25 ("resolve all
  branches to main/merge and deconflict, handle pull requests. then sync.
  then usig the agent-skills github release skill, release"); source
  baseline `c7e3eb4` (local `main` tip before this campaign, itself the
  `docs: close out the 2026-07-23 residual-risk repair campaign` commit).
