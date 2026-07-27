# Feature Ledger: repair-campaign-cycle1

**feature id:** `repair-campaign-cycle1`

## Multi-lens audit + gated repair-defect-campaign, cycle 1 of 2 (2026-07-27)

**action summary:** Ran a 5-lens agent-skills audit (`audit-security-nodejs`,
`audit-reliability`, `audit-dataflow-integrity`, `audit-dependency-criticality`,
`audit-architecture-nodejs`, via `e3742526/agent-skills`) against this repo,
producing 16 findings (0 Critical, 5 High, 9 Medium, 2 Low). Ran the
`020_repair/repair-defect-campaign` skill over those findings: grouped into 8
gated stages by shared surface, each patched, tested, adversarially reviewed,
change-reviewed, and committed separately. Part 1 of a two-cycle audit→repair
run requested for this repo; cycle 2 (re-audit + repair) follows.

**status:** cycle 1 complete (`completed_verified`); 4 residual items routed as
follow-ups (see below), not stacked into this cycle.

**touched files (by stage):**
- Group 1 (org-lifecycle-data-integrity): `gateway/org.ts`, `gateway/org-validation.ts`,
  `gateway/department-rename.ts`, `gateway/org-services.ts`, `gateway/api/routes/org.ts`,
  `gateway/server.ts`, `shared/types/operations.ts` (+tests)
- Group 2 (session-data-integrity): `sessions/registry-archives.ts`,
  `shared/types/archives.ts`, `gateway/session-resources.ts`, `gateway/ticket-dispatch.ts`,
  `packages/web/src/lib/api-archives.ts` (+tests)
- Group 3 (daemon-startup-reliability): `gateway/lifecycle.ts`, `cli/start.ts` (+tests)
- Group 4 (resume-dispatch-race-guards): `gateway/checkpoints.ts`,
  `orchestration/store-continuations.ts`, `orchestration/store.ts`, `orchestration/runtime.ts` (+tests)
- Group 5 (pty-engine-preflight): `gateway/server/transports.ts`
- Group 6 (onboarding-config-validation): `gateway/api/routes/system.ts`,
  `shared/config-schema.ts`, `shared/models.ts` (+tests)
- Group 7 (web-contracts-type-dedup): `packages/contracts/src/org.ts` (new),
  `packages/contracts/src/index.ts`, `shared/types/org-change.ts`,
  `packages/web/src/lib/api-hr.ts`
- Group 8 (low-severity-hardening-sweep): `gateway/server/http-static.ts`,
  `.github/workflows/bump-formula.yml` (+tests)

**validation run:**
- `pnpm typecheck` — green after every stage and at closeout (all 3 packages).
- `pnpm lint` — green after every stage and at closeout (0 warnings, all 3 packages).
- Per-stage targeted `vitest` suites — green; each new regression test that
  could be adversarially verified was confirmed to fail without its fix
  (temporarily reverted, confirmed red, restored) before being kept.
- Full `pnpm test` (all 3 packages) — green at baseline, after Group 1, and at
  closeout after Group 8.

**defects repaired:** DFI-001, DFI-002, DFI-003, DFI-004 (partial — see residual),
DFI-005, DFI-006, DFI-007, ARC-001, ARC-002, DEP-001, REL-001, REL-002, REL-003,
REL-004, SECN-NODE-001, SECN-NODE-002.

**remaining open items (routed, not stacked here):**
- DFI-004: engine/model-registry and reportsTo-cycle validation still not
  enforced at org.ts's persistence boundary (rank/lifecycle now are) — needs
  `config` threaded into org.ts's YAML writers, a wider-blast-radius change.
- DFI-007 (ticket-dispatch.ts call site) and DEP-001: fixed and typechecked,
  no bespoke new regression test (rely on shared-primitive coverage / no
  existing test harness for socket-upgrade handling, respectively).
- DEP-001's defense-in-depth suggestion (async engine-spawn-failure signal
  through PtyStreamManager to the frontend) not implemented — separate,
  larger follow-up touching 6 engine files + the frontend.
- `config-schema.ts`'s local `ENGINE_NAMES` Set duplicates `models.ts`'s
  exported array (same values, out of DFI-005's scope to dedupe).

**provenance:** original — audit + repair campaign against the working tree on
branch `claude/merge-repair-defects-86m0pw`, each of the 8 groups committed and
validated separately (commits `03f003d`, `57518bb`, `b1b01ee`, `0bf484f`,
`a233e9b`, `4c99276`, `8de7a02`, `c53e050`). Cloud/remote session; Giles tool
not invoked (waived per CLAUDE.md); this ledger authored per the repo-local
requirement. Full detail in
`docs/logs/session/072026/2026-07-27-repair-defect-campaign-cycle1.md` and
`docs/audits/2026-07-27-agent-skills-multi-lens-audit-cycle1.md` (both local,
git-ignored per this repo's audit/session-log conventions).
