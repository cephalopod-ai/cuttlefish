# Feature Ledger: operator-docs-polish

**feature id:** `operator-docs-polish`

## Operator documentation polish (2026-09-27)

**action summary:** Clarified the packaged-install versus source-checkout CLI
syntax in the README, installation guide, and user manual; made the manual's
headings consistent; corrected stale engine-count wording and malformed spacing
in the documentation index; and aligned comments in the development example.

**status:** implemented; validation results recorded below.

**provenance:** direct comparison of the root package scripts and the maintained
operator documentation. This entry records evidence only and does not declare
compliance.

**touched files:**
- `README.md`
- `docs/USER_MANUAL.md`
- `docs/INSTALL.md`
- `docs/INDEX.md`
- `.giles/feature-ledger/giles-ledger-0105-operator-docs-polish-20260927.md`

**validation run:** `pnpm typecheck` passed all 4 tasks; `pnpm lint` passed all
3 tasks; `pnpm test` passed the contracts package (6 tests), the web package
(899 tests), and 3,290 of 3,291 executed CLI tests. The one CLI failure was the
port-occupancy assertion in `lifecycle-stop.test.ts`, because this environment
does not provide `lsof`; the runner also reported 3 intentional skips. A local
Markdown-link target check passed for all four edited operator documents, and
`git diff --check` passed.

**remaining open items:**
- Re-run the full test suite in an environment with `lsof` to exercise the
  port-occupancy assertion; this is outside the editorial documentation scope.
