# Code Polish TODO Ledger

## Scope

This ledger tracks active code-polish debt found during the 2026-06-26
Cuttlefish rebrand polish pass. It excludes generated files, ignored local
artifacts, build outputs, lockfiles, and archived planning snippets.

## Active Items

| ID | Status | Evidence | Disposition | Exit criteria |
|---|---|---|---|---|
| POLISH-20260626-001 | verified-not-a-defect | `packages/cuttlefish/src/cli/*.ts` uses `console.log` for command output. | CLI stdout is an intentional user-facing interface, not debug noise. | Preserve unless a structured output redesign is explicitly requested. |
| POLISH-20260626-002 | deferred-with-risk | `docs/plans/2026-03-06-cuttlefish-implementation.md` contains historical `TODO` examples. | Historical design-plan snippets are archival, not active source debt. | Revisit only during a dedicated docs archival pass. |
| POLISH-20260626-003 | fixed | `packages/cuttlefish/src/cli/instances.ts` imported `TEMPLATE_DIR` without using it. | Removed the stale import. | `pnpm --filter cuttlefish-cli typecheck` and lint pass. |

## Scan Notes

- No active `FIXME`, `HACK`, `XXX`, or `debugger` markers were found in source
  during this pass.
- Runtime cleanup language in source is domain behavior and not a polish marker.
- Existing ignored local audit/log trees under `docs/audits/` and `docs/logs/`
  were excluded per `AGENTS.md`.
