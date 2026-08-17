# Structure & Convention Compliance

- Governing authority: Giles conventions as constrained by the repository contract.
- Authority sources: `AGENTS.md` retention blocks, `.gitignore`, `docs/INDEX.md`,
  `.giles/audit_report.yaml` and `.giles/compliance_status.yaml` (both generated
  2026-08-12T13:52:58Z), `governance/logs/giles_compliance_todo.{json,md}`
  (canonical mirror, in sync with the `.giles/` sidecar as of the same date).
- Summary: 0 compliant / 15 violation or drift / 2 informational-only rows
  outside Giles' current scan — Tier A: 7, Tier B: 5, Tier C: 4.

The Giles sidecar reports 19 open raw findings and 2 required actions, 0
blocking (`compliance_result: pass`, `accepted_with_exceptions`). **None of the
19 Giles findings is claimed resolved here** — this pass only reconciles the
compliance-status table against the live tree and flags one likely-moot finding
(STRUCT-3) for a fresh Giles rerun to confirm, not to close unilaterally. The
Giles snapshot is 4 days stale relative to this pass (2026-08-12 vs. 2026-08-16);
new files have landed since (STRUCT-2) that reproduce an already-flagged pattern.

| ID | Rule/giles code | Location | Status | Severity | Tier | Recommended action | Authority needed |
|---|---|---|---|---|---|---|---|
| STRUCT-1 | `GAUD-001` | `docs/audits/2026-07-10-adversarial-repository-security-review.md` | violation | info | A | Run `giles audit-retention apply` to bucket the loose file into `072026/`. | none (Giles mechanical) |
| STRUCT-2 | `GAUD-001` (recurrence, unscanned) | `docs/audits/2026-08-16-vibe-playtest-full-library.md` | violation | info | A | Same pattern as STRUCT-1, landed after the last Giles scan — bucket into `082026/` and re-run Giles. | none (Giles mechanical) |
| STRUCT-3 | `GAUD-002` | `docs/audits/072026`, `docs/audits/082026` | drift | info | A | Giles flagged 2 buckets missing summaries at scan time; both `072026-audit-summary.md` and `082026-audit-summary.md` now exist on disk — likely resolved, needs a fresh `giles compliance-todo --refresh` to confirm and close. | none, but needs Giles rerun to confirm |
| STRUCT-4 | `GAUD-003` | `.gitignore` | violation | info | A | Managed audit-retention block is missing 1 pattern for an existing bucket; run `giles audit-retention apply` to refresh it. | none (Giles mechanical) |
| STRUCT-5 | `GAUD-006` | `docs/audits/072026/2026-07-21-sb-cut-001-gate0-baseline.md` (+3 other force-tracked files under gitignored trees) | violation | info | A | 4 files remain git-tracked inside now-ignored `docs/audits/`, `docs/logs/session/`, `.giles/` trees. The SB-CUT-001 pair is already documented in `docs/INDEX.md` as an intentional exception; `.giles/feature-ledger/*` (9 files) and `docs/logs/session/082026/2026-08-16-vibe-playtest-session.md` are not yet documented as exceptions. | maintainer decision: untrack vs. document as exception |
| STRUCT-6 | `GDOC-023` | `docs/audits/index.yaml` | violation | low | B | `docs/audits/` has no `index.yaml`; audits are undiscoverable outside git. | maintainer decision on whether an audit index is wanted given local-only/gitignored posture |
| STRUCT-7 | `GDOC-023` | `docs/INDEX.md` | violation | medium | A | **Fixed this pass** — added links for the 7 previously-unlinked release docs (`v0.0.1`–`v0.23.6`). | none — doc edit only |
| STRUCT-8 | `GDOC-025` | `docs/audits/2026-07-10-adversarial-repository-security-review.md` | violation | low | A | Audit record has no frontmatter. Add standard frontmatter block. | none |
| STRUCT-9 | `GSESS-005` | `docs/logs/session/072026`, `docs/logs/session/082026` | violation | info | B | Both monthly buckets lack a root `MMYYYY-session-summary.md`. | maintainer decision: adopt tracked session summaries or document exception |
| STRUCT-10 | `GSESS-007`, `GTIER-003` | `logs/` (root) | violation | info | B | Root `logs/` exists (only `.gitkeep`) with no README explaining its purpose, unlike the equivalent `src/README.md`/`tests/README.md` placeholders. | maintainer: add `logs/README.md` (Tier A once decided) |
| STRUCT-11 | `GTIER-005` | `AGENTS.md` | drift | info | C | No Codex config raises `project_doc_max_bytes` to cover the 12,415-byte `AGENTS.md`. Info-only per Giles. | none required; optional maintainer convenience fix |
| STRUCT-12 | `GILES-AGENTS-DRIFT` | `CLAUDE.md` | **violation (open, unresolved — human decision required)** | medium | B | Giles' `align-agents-contract` remediation action is still `status: pending`, 0% complete. Giles classifies `CLAUDE.md` as agent-alias drift against its fleet standard even though this repo's `CLAUDE.md` is a deliberate 14-line pointer to `AGENTS.md`. **Not resolved or exception-documented in this pass** — this is a hard-gate item (Giles: `human_required`, `classification: decision_required`); doc stewardship does not have authority to decide fleet-alignment vs. exception on its own. | human decision required |
| STRUCT-13 | `GCFG-002/003/004` | repo-wide scripts (190/22/75 findings) | drift | info | C | Config-centralization findings across scripts. No mechanical fix registered by Giles. | maintainer/architecture decision — out of scope for a doc-only pass |
| STRUCT-14 | `GDIA-003/004/005` | `docs/agent/mermaid-diagram-guidance.md`, `docs/IMPLEMENTATION_DIAGRAMS.md` | drift | info | C | Local Mermaid guidance has drifted from the canonical Giles template; 3 diagrams lack subgraph layers; 2 have fan-out without a named boundary node. | maintainer decision — diagram rework, no mechanical fix |
| STRUCT-15 | `GDOC-062` | repo-wide (7 commits) | drift | info | C | 7 commits lack registry linkage. | maintainer/governance decision on registry backfill |
| STRUCT-16 | duplicate-role dirs (new, not in Giles) | `.agents/skills/`, `.claude/skills/` | drift | info | B | Two parallel skill-symlink directories — expected per the repo's own template (auto-synced for different engine tools), not an error. Noted here so it isn't re-flagged as accidental duplication. | none — documentation note only |
| STRUCT-17 | empty/placeholder dirs (new, not in Giles) | `.dory/*` runtime-state subdirs, `packages/web/src/routes/talk/cards/__tests__` | compliant | info | A | Local-only tool runtime state (`.dory/`) and one empty test-fixture dir. Not currently in Giles' 19 findings. | none if confirmed intentional; else Tier A cleanup |

## Tier B — routed (recommended diff + approval path)

- **STRUCT-12 (`GILES-AGENTS-DRIFT`)** — the highest-priority open item. Giles
  flags `CLAUDE.md` as drift against a fleet alias standard; this repo's
  `CLAUDE.md` is a deliberate thin pointer to `AGENTS.md` (see `CLAUDE.md`
  itself and `AGENTS.md`'s own framing). Two paths: (1) align `CLAUDE.md` to
  Giles' fleet standard, or (2) record a governed exception in
  `governance/exceptions.yaml` explaining the deliberate pointer pattern.
  Neither was applied in this pass — this is an explicit stop-and-report item
  per this skill's authority model (renaming/restructuring agent-contract
  files requires explicit caution and cannot be decided by the doc-stewardship
  pass alone).
- **STRUCT-5/6/9/10/16** — retention-exception documentation and a `logs/README.md`
  addition. Recommended as a single follow-up governed change touching
  `docs/INDEX.md`, `.gitignore`, and `logs/README.md`.

## Tier C — significant re-work (scoped follow-up)

- STRUCT-13 (config centralization), STRUCT-14 (Mermaid template drift),
  STRUCT-15 (commit registry linkage) — each requires a dedicated follow-up
  pass with its own scope; not attempted here.

## Notes

- STRUCT-7 was applied in this pass (mechanical `docs/INDEX.md` link addition,
  no restructuring).
- No Giles finding is suppressed or claimed resolved by this document. STRUCT-3
  is flagged as *likely* resolved based on filesystem evidence but is left open
  pending a fresh Giles scan, per this skill's rule against self-certifying a
  Giles-owned finding.
- Items routed to `governance-repo-cleaning` (whole-tree/non-doc hygiene): none
  identified this pass beyond what Giles already tracks under STRUCT-13.
