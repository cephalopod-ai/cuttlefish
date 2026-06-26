# Code Polish Report

## Summary

- Date: 2026-06-26
- Repo: `/home/ericl/Work/vscode/public_share/cuttlefish`
- Branch: `main`
- Agent: Codex
- Scope: focused code-polish stewardship after the Cuttlefish rebrand and audit repair pass.
- Behavior changes: none.

## Scope

### Included

- Startup/convention scan of repo docs, manifests, lint/test/CI config, source layout, tracked artifact risks, and TODO/debug markers.
- Low-risk stale-import cleanup in active CLI code.
- Required TODO ledger creation for current code-polish debt.
- Required polish report artifacts under `docs/polish/`.

### Excluded

- Public API, CLI, route, schema, migration, and package-name renames.
- Repo-wide source headers, because the repo has no existing source-header convention and broad header churn would be noisy.
- Historical docs rewrite, dependency changes, generated files, lockfiles, and build outputs.

## Files Changed

| File | Change type | Reason |
|---|---|---|
| `docs/polish/intake.md` | report artifact | Record repo-state intake. |
| `docs/polish/convention-baseline.md` | report artifact | Record discovered conventions and exclusions. |
| `docs/polish/source-header-policy.md` | report artifact | Document no-header convention and future policy. |
| `docs/polish/rename-manifest.md` | report artifact | Record that no renames were applied. |
| `docs/polish/structure-review.md` | report artifact | Record structure observations and cleanup. |
| `docs/polish/todo-ledger.md` | report artifact | Track active polish TODO dispositions. |
| `docs/polish/polish-report.md` | report artifact | Final polish summary. |
| `packages/cuttlefish/src/cli/instances.ts` | source polish | Removed a stale import left after single-instance hardening. |
| `packages/cuttlefish/src/shared/__tests__/paths.test.ts` | regression guard | Added a package-surface scan preventing inherited gateway port reuse. |

## Naming Changes

| Symbol | Old name | New name | Reason | Risk |
|---|---|---|---|---|
| None | None | None | No low-risk naming change was justified. | none |

## File/Directory Renames

| Old path | New path | Reason | Reference update strategy | Risk | Verified |
|---|---|---|---|---|---|
| None | None | No renames applied. | Not applicable. | none | Not applicable. |

## Headers Added Or Normalized

| File group | Count | Notes |
|---|---:|---|
| Active source files | 0 | Existing repo convention does not use per-file headers; broad header churn deferred. |

## Comments/Docstrings Added

| File | Function/Class | Reason |
|---|---|---|
| None | None | No source comment/docstring patch was needed for this focused pass. |

## Dead Code Removed

| File | Removed item | Evidence unused |
|---|---|---|
| `packages/cuttlefish/src/cli/instances.ts` | `TEMPLATE_DIR` import | No references in the module after the single-instance cleanup. |

## TODO/FIXME Disposition

| ID | File | Status | Disposition |
|---|---|---|---|
| POLISH-20260626-001 | CLI stdout | verified-not-a-defect | `console.log` in CLI command files is intentional user-facing output. |
| POLISH-20260626-002 | Historical docs | deferred-with-risk | Archival TODO snippets left for a dedicated docs archival pass. |
| POLISH-20260626-003 | `instances.ts` | fixed | Removed stale `TEMPLATE_DIR` import. |
| POLISH-20260626-004 | port isolation | fixed | Added a regression guard against the inherited gateway port in runtime package surfaces. |

## Architecture/Layout Observations

### Issues Corrected

- A stale CLI import left after the single-instance hardening was removed.
- Runtime package surfaces now have a test guard against reintroducing the inherited gateway port.

### Deferred Observations

- `.claude/` and `.agents/` are tracked tooling surfaces. They may be intentional, but they deserve a dedicated public-tooling review before any cleanup. `.fissure/` is local-only tooling and is ignored.
- Historical docs/specs are extensive and may benefit from a future archival/indexing pass.

## Validation Commands

| Command | Result | Notes |
|---|---|---|
| `pnpm --filter cuttlefish-cli typecheck` | passed | `tsc --noEmit` completed successfully. |
| `pnpm --filter cuttlefish-cli lint` | passed | ESLint completed with `--max-warnings=0`. |
| `pnpm --filter cuttlefish-cli test -- src/cli/__tests__/instances-safety.test.ts src/shared/__tests__/paths.test.ts` | passed | Vitest completed with 198 files passed, 1559 tests passed, 1 skipped. |
| `pnpm --filter cuttlefish-cli test -- src/shared/__tests__/paths.test.ts` | passed | Vitest completed with 198 files passed, 1560 tests passed, 1 skipped after adding the port guard. |
| `git diff --check` | passed | No whitespace errors. |
| live Cuttlefish status | passed | Running daemon reports port `8888`; the separate upstream process remains on its inherited port. |

## Remaining Risks

- Full `pnpm build`, full `pnpm test`, and e2e checks are outside this narrow polish pass unless later run separately.
- Historical planning docs still contain TODO/example snippets by design.

## Deferred Recommendations

- Run a dedicated public-tooling review for `.claude/` and `.agents/`.
- Run a docs archival pass if old planning/spec documents should be made less prominent in the public repo.
- Avoid repo-wide source headers unless the team deliberately adopts them as a convention.

## Public API Compatibility Notes

- No public APIs, CLI commands, package exports, routes, config keys, schemas, or migrations changed.
