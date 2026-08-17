# Code Polish Report

## Summary

A code-polish pass (`governance-code-polish`) was run against the cuttlefish
repo on 2026-08-17. The repo entered the pass in an unusually clean state —
all four baseline gates (typecheck, lint, test, build) were green with zero
pre-existing failures, and a first-pass scan across all six assessable POL
codes found **zero genuine findings**. No code-polish patches were required or
applied. This report exists to disposition the required coverage table and
document the one governance gap surfaced (POL-008 lint blindness).

## Scope

`packages/cuttlefish/src` (378 non-test `.ts` files) and `packages/web/src`
(228 non-test `.ts`/`.tsx` files), excluding `__tests__/` directories and
`*.test.*` files. `packages/contracts` was included in baseline validation but
not independently POL-scanned (small, shared-type-only package).

## Files changed

None. This was a report-only pass for the code surface; no source files were
modified. (Documentation changes from the paired `governance-doc-stewardship`
pass are tracked separately — see `docs/STRUCTURE_COMPLIANCE.md` and
`docs/DOCUMENTATION_INVENTORY.md`.)

## Naming changes

None proposed. Existing conventions (kebab-case files, camelCase
functions/variables, PascalCase classes) are already consistent across both
packages.

## File/directory renames

None.

## Headers added or normalized

None. The repo has no file-header/license-banner convention (files begin
directly with imports); this is an existing, consistent convention, not a
gap — POL-003 is dispositioned `n/a` below.

## Comments/docstrings added

None needed. JSDoc is used selectively and accurately for actual API
documentation; no missing-docstring gap was found on the sampled high-risk
public surfaces (CLI entrypoint, gateway API routes, web UI entry,
`packages/contracts`).

## Dead code removed

None found. See POL-008 below for the one caveat on detection method.

## TODO/FIXME disposition

Zero floating markers found. Grep for `FIXME`/`HACK`/`XXX` returned no hits
anywhere in `packages/cuttlefish/src`, `packages/web/src`, or
`packages/contracts/src`. The only `TODO` string hits (`board-worker.ts:20`,
`:179`, `settings-config-sections.tsx:753`) are the literal name of a kanban
board status ("TODO tickets"), not floating debt markers.

## Architecture/layout observations

None raised by this pass. Repo-wide architecture/config-centralization
findings already exist under Giles (`GCFG-002/003/004`, routed as
STRUCT-13 in `docs/STRUCTURE_COMPLIANCE.md`) and are out of scope for a
code-polish pass — no mechanical fix, requires an architecture decision.

## POL coverage table (mandatory — one row per POL-001..018)

| Code | Disposition | Evidence |
|---|---|---|
| POL-001 Misleading/inconsistent symbol names | clean | Naming conventions consistent across both packages (kebab-case files, camelCase vars/functions, PascalCase classes); no misleading names surfaced during the intake scan. |
| POL-002 File/directory naming violations | clean | Same evidence as POL-001; no violations found. |
| POL-003 Source header issues | n/a | Repo has no header/banner convention (files begin with imports); this is the repo's existing, consistent choice, not a gap to fill. |
| POL-004 Missing public API docstrings | clean | Sampled high-risk public surfaces (CLI entrypoint `bin/cuttlefish.ts`, gateway API routes, `packages/contracts/src`, `packages/web/src/main.tsx`) carry adequate documentation; no missing-docstring findings surfaced. |
| POL-005 Comment rot | clean | 0 findings. All flagged candidates were legitimate, accurate comments describing intentional backward-compat/fallback behavior (e.g. `shared/config.ts` legacy Codex context-window handling). |
| POL-006 Commented-out code | clean | 0 findings. All `//`-prefixed candidate lines were prose explanation, not disabled code. |
| POL-007 Debug remnants | clean | 0 findings. `console.log` usage in `cli/**` is intentional CLI stdout output; the single `console.log` in `shared/logger.ts` is the module's own gated stdout sink. No `debugger;` statements anywhere. |
| POL-008 Dead code (safe tier) | **n/a — not assessable via configured tooling; governance gap flagged, not fixed** | `eslint.config.mjs` explicitly disables `@typescript-eslint/no-unused-vars` repo-wide (deliberate, documented convention), and no `tsconfig` sets `noUnusedLocals`/`noUnusedParameters`. A genuine POL-008 pass needs an explicit, disclosed, temporary read-only override (e.g. `ts-prune` or a scoped lint-rule enable) rather than treating `pnpm lint`'s silence as clearance. Not applied in this pass — changing lint config is outside code-polish's non-goals boundary without operator sign-off. |
| POL-009 Floating TODO/FIXME/HACK markers | clean | 0 genuine markers found repo-wide; see TODO disposition above. |
| POL-010 Magic literals | not independently re-verified | Not sampled with dedicated tooling this pass; no candidates surfaced incidentally during the POL-005/006/007/009/011/015 scan. Deferred — no evidence of a problem, but not exhaustively checked. |
| POL-011 Logging hygiene | clean | Central `shared/logger.ts` applies `redactText()` to every message before write; no logged secrets found (`mcp/resolver.ts:176` logs the *absence* of a key, not a value); no wrong-log-level patterns spotted in sampled output. |
| POL-012 Error-handling text and broad catches | not independently re-verified | Not sampled with dedicated tooling this pass; flag-only code (route to security/semantics skills if a broad-catch defect is later found), no findings surfaced incidentally. |
| POL-013 Vague test names/fixtures | not independently re-verified | Not sampled this pass; test suite is large (≈3470 tests) and out of scope for a triage-level intake. |
| POL-014 Stale doc/code references | handled under `governance-doc-stewardship` | Doc-code alignment (missing `docs/INDEX.md` links, stale `docs/STRUCTURE_COMPLIANCE.md`/`docs/DOCUMENTATION_INVENTORY.md` dates) is the doc-stewardship pass's mandate; see that pass's output for disposition, not duplicated here. |
| POL-015 Formatting drift | clean | `pnpm lint` is clean with `--max-warnings=0` enforced across all 3 packages; no separate formatter configured, ESLint is the sole style gate and it passes. |
| POL-016 Oversized files/functions | not independently re-verified — route to `repair-source-modularization` if found | Not sampled this pass; no candidates surfaced incidentally. |
| POL-017 Architecture boundary violations | routed — see `docs/STRUCTURE_COMPLIANCE.md` STRUCT-13 | Giles already tracks config-centralization drift (`GCFG-002/003/004`); no additional code-polish-specific boundary violation surfaced. |
| POL-018 Duplicate helpers | not independently re-verified | Not sampled this pass; no candidates surfaced incidentally during the triage scan. |

## Baseline compare (pre vs post, deltas explained)

Pre-polish baseline (recorded before any inspection):

| Command | Result | Time |
|---|---|---|
| `pnpm typecheck` | PASS, 0 errors | 3.38s |
| `pnpm lint` | PASS, 0 errors/warnings | 3.76s |
| `pnpm test` | PASS, ≈3470 passed / 3 skipped / 0 failed | 77.9s |
| `pnpm build` | PASS, 0 errors (1 benign Vite loader deprecation notice) | 0.59s (mostly cached) |

Post-pass: **no source files were changed** by this skill, so no post-polish
re-run was required to detect a behavior delta — there is no delta to explain,
because there is no polish diff. (The paired documentation changes from
`governance-doc-stewardship` do not affect typecheck/lint/test/build and were
validated separately — see that pass's evidence.)

## Diff audit result

N/A — zero source-code hunks were produced by this pass. Nothing to trace to a
POL code; nothing to revert.

## Validation commands

- `pnpm typecheck` — PASS (pre-baseline; not re-run post-pass, no source diff)
- `pnpm lint` — PASS (pre-baseline; not re-run post-pass, no source diff)
- `pnpm test` — PASS (pre-baseline; not re-run post-pass, no source diff)
- `pnpm build` — PASS (pre-baseline; not re-run post-pass, no source diff)

## Remaining risks

- POL-008 is a real, disclosed governance gap: the repo cannot currently
  detect unused imports/exports/dead code through its own lint gate. Not
  fixed here because enabling a new lint rule is a config change beyond a
  cleanup-safe default and needs operator sign-off.
- POL-010, 012, 013, 016, 018 were not independently re-verified with
  dedicated tooling in this triage-level pass; no incidental findings
  surfaced, but a deeper pass with more time/tooling could still find
  something these codes cover.

## Deferred recommendations

- If dead-code detection is wanted, propose a scoped follow-up: run `ts-prune`
  (or temporarily enable `@typescript-eslint/no-unused-vars` in report-only
  mode) against both packages, review findings with the operator, then decide
  whether to re-enable the rule permanently or keep it off with the reason
  recorded.
- POL-010/012/013/016/018 could be given a dedicated deeper pass if the
  operator wants full coverage rather than triage-level assurance.

## Public API compatibility notes

Not applicable — no renames, no public surface changes, no source edits in
this pass.
