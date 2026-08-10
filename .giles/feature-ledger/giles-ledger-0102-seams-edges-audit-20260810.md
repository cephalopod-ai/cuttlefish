# Feature Ledger: seams-edges-audit

**feature id:** `seams-edges-audit`

## Reasoning, logic, and obsolete-path audit (2026-08-10)

**action summary:** Audited boundary logic and redundant/obsolete workflow
surfaces across the gateway, dashboard, collaboration feed, compatibility
configuration, and tracked repository tooling. Recorded two P2 findings: the
retired browser Talk workflow retains a large mutable backend compatibility
surface with no production dashboard caller, and tracked machine-specific audit
scratch files remain despite prior cleanup findings.

**status:** audit complete; remediation remains open.

**provenance:** direct source inspection, repository-wide targeted searches,
and local monorepo validation. Giles and Dory executables were unavailable, so
this entry records manual evidence and does not declare compliance.

**touched files:**
- `docs/audits/082026/2026-08-10-seams-and-edges-audit.md` (local, git-ignored
  audit artifact)
- `.giles/feature-ledger/giles-ledger-0102-seams-edges-audit-20260810.md`

**validation run:** `pnpm typecheck` (passed); `pnpm lint` (passed); `pnpm test`
(313 cuttlefish-cli files and 2,620 tests passed, 2 skipped; one pre-existing
port-occupancy assertion failed in `lifecycle-stop.test.ts:159` because
`status.error` was undefined, and Turbo therefore did not complete the web test
task in that run); targeted `rg`, `git ls-files`, and `wc -l` inspections
confirmed the stated reachability, references, tracked status, and 2,380-line
size of the obsolete surfaces.

**remaining open items:** Decide whether backend Talk is a supported external
compatibility API or should be decommissioned, then document/test or remove it
accordingly. Remove the tracked machine-local scratch data and scripts after
checking their raw defect snapshot for any unique unresolved issue. No live
daemon, connector, engine, or browser playtest was performed.
