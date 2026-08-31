# Documentation Index

This index lists operator-facing docs that are maintained in this checkout.
Audit and session logs under `docs/audits/` and `docs/logs/` are local-only
artifacts unless explicitly published. Both trees are listed in `.gitignore`,
which suppresses only *untracked* files, so a file deliberately added there
stays tracked and published; the audit files linked individually below are
those deliberate cases.

## Current Operator Docs

- [docs/AGENTS.md](AGENTS.md): documentation-subtree guidance (defers to root `AGENTS.md`).
- `README.md`: public overview and install/use workflow.
- `CHANGELOG.md`: release/version history, including the failed `v0.1.0`
  pre-release and its non-installable status.
- `docs/INSTALL.md`: operator install matrix (Windows / macOS / Linux; npm,
  Homebrew, GitHub platform archives, source) including `scripts/install.ps1`
  and `scripts/package-windows.ps1`.
- `docs/RELEASING.md`: release contract for the npm package, GitHub platform
  archives, and Homebrew formula; documents the historical failed `v0.1.0`
  pre-release accurately.
- `docs/changes/releases/v0.23.7.md`: v0.23.7 public release statement covering
  trust-boundary hardening, runtime/data-integrity repairs, Windows readiness,
  and operator-impacting upgrade notes; currently marked incomplete because
  npm, platform assets, and Homebrew remain at v0.23.6.
- `docs/changes/releases/`: per-release statements for prior versions
  ([v0.23.6](changes/releases/v0.23.6.md), [v0.23.5](changes/releases/v0.23.5.md),
  [v0.23.4](changes/releases/v0.23.4.md), [v0.1.0](changes/releases/v0.1.0.md),
  [v0.0.3](changes/releases/v0.0.3_resource_mgt_improve.md),
  [v0.0.2](changes/releases/v0.0.2-workinprogress.md),
  [v0.0.1](changes/releases/v0.0.1-rebrand-jinn.md) — the pre-`0.23.x` tag
  names CHANGELOG.md's history note refers to).
- `docs/USER_MANUAL.md`
- `docs/QDRANT_SETUP.md`: maintained user manual for setup, workflows,
  persistence, recovery, and troubleshooting.
- `docs/ARCHITECTURE.md`: current architecture summary, component map,
  persistence map, boundaries, risks, and extension points.
- `docs/SPECIFICATION.md`: source-grounded product specification with
  requirement IDs and validation requirements.
- `docs/IMPLEMENTATION_DIAGRAMS.md`: Mermaid diagrams for runtime, docs, and API
  routing.
- `docs/feature_inventory.md`: implemented CLI/API/UI surfaces and fidelity gaps.
- `docs/TEST_LEDGER.md`: current validation evidence and test coverage map.
- `docs/test_scenarios/README.md`: end-to-end playtest scenario library for
  exploratory user-facing test passes (derived from the `audit-playtest-app`
  baseline), plus per-surface scenario files under `docs/test_scenarios/`
  (`01`–`10` core surfaces; `11` model selection/switching; `12` failover;
  `13` inter-agent communication; `14` authorization/approvals; `15`
  stress/adversarial load; `16` autonomous operation and integrity boundaries;
  `17` operations/data lifecycle; `18` orchestration control-plane semantics;
  `19` manager handoff, operator-attention, and delegated-job completion;
  `20` session authority collision, arbitration, and human-notification semantics).
- `docs/test_scenarios/PLAYTEST_EXECUTION.md`: required disposable-state,
  capability-gate, evidence, cleanup, and reporting contract for executing the
  scenario library without overstating partial coverage.
- `docs/TODO_LEDGER.md`: current active documentation/governance TODO ledger.
- `docs/TODO_HISTORY.md`: closed defects and completed TODOs with preserved
  closure evidence.
- `docs/DECISION_LOG.md`: accepted and deferred documentation/governance
  decisions.
- `docs/DOC_MAINTENANCE.md`: documentation update contract for future changes.
- `docs/DOCUMENTATION_INVENTORY.md`: inventory of canonical, current,
  historical, local-only, and generated documentation surfaces.
- `docs/STRUCTURE_COMPLIANCE.md`: documentation structure and retention-policy
  compliance report.
- `docs/UPSTREAM_DIFF_BASELINE.md`: source-grounded comparison between this
  checkout and the configured upstream baseline.
- `docs/LOG_ARCHIVE.md`: raw-log retention policy and durable summary index.
- `docs/agent/mermaid-diagram-guidance.md`: local guidance for Mermaid diagrams
  in architecture and workflow docs.
- `docs/polish/polish-report.md`: latest code-polish stewardship report and
  linked baseline artifacts.
- `docs/known-diagnostics.md`: accepted non-actionable diagnostics that future
  audits should not re-report unless explicitly scoped.
- `docs/script-surface-map.md`: authoritative classification of npm scripts and CLI
  subcommands by destructiveness, interactivity, and suitability for automated sweeps;
  supersedes any generated surface-metadata that conflicts with it.
- `docs/engines-hermes.md`: Hermes engine behavior and caveats.
- `docs/TWILIO_SMS.md`: Twilio SMS credential, sender, allowlist, and signed-webhook setup.
- `docs/orchestration/README.md`: provider-neutral matrix orchestration
  foundation, durable scheduler state, adapter contracts, CLI dry-run/observe
  commands, opt-in live run modes, git worktree execution, and orchestration
  HTTP routes.
- `docs/audits/2026-08-31-roles-skills-architecture-review.md`: source-grounded
  review of an external "MODE / ROLE / SKILLS" proposal against the shipped
  orchestration role model and skills subsystem, with findings, courses of
  action, and mitigations. One of the deliberately published audit files (see
  the retention note above); records no decision.

## Session and Audit Log Summaries

Raw session logs (`docs/logs/session/`) and audit details (`docs/audits/`)
are local-only artifacts: the repository `.gitignore` excludes both trees,
and per `docs/DOC_MAINTENANCE.md` they are not published unless a maintainer
explicitly selects and reviews them. Do not treat this index as a list of
tracked audit/session files.

One tracked baseline pair was force-added before the ignore rule and remains
in the checkout:

- `docs/audits/072026/2026-07-21-sb-cut-001-gate0-baseline.md` and
  `docs/logs/session/072026/2026-07-21-sb-cut-001-gate0-baseline.md`: the
  Gate-0 collaboration-prototype baseline record (initial evidence for
  SB-CUT-001); its findings feed the active TODO ledger.

Curated summaries of completed campaigns (for example the August 2026
agent-skills audit and repair campaign, the July 2026 comprehensive audit and
repair campaign, and the SB-CUT-001 collaboration completion) are reflected
in `docs/TODO_LEDGER.md`, `docs/TODO_HISTORY.md`, `docs/TEST_LEDGER.md`, and
the `.giles/feature-ledger/` entries rather than in tracked raw-log files.

## FleetView Implementation Status

- `docs/plans/2026-07-10-fleetview-ux-implementation-plan.md`: the reference
  roadmap for the FleetView web dashboard. Phases 0–6 each have an implemented,
  scoped slice; remaining UX backlog and validation limits are deliberately
  deferred and recorded in their corresponding Giles feature-ledger entries.

## Historical Design And Planning Archives

## Historical Audit Baselines

- `docs/cloud-audit/AUDIT-BASELINE-2026-06-30.md`
- `docs/cloud-audit/AUDIT-SWEEP-2026-07-01.md`
- `docs/cloud-audit/FORK-READINESS-2026-06-30.md`
- `docs/cloud-audit/FULL-AUDIT-PLAYTEST-2026-07-10.md`
- `docs/cloud-audit/PLAYTEST-THEME-2026-07-01.md`
- `docs/cloud-audit/REPAIR-CAMPAIGN-2026-07-10.md`
- `docs/cloud-audit/SECURITY-FINDINGS-2026-06-30.md`
- `docs/cloud-audit/SECURITY-FINDINGS-audit-security-2026-07-02.md`
- `docs/cloud-audit/SYSTEM-EVALUATION-2026-07-04.md`

These are historical audit inputs. They retain their original observations and do
not override the canonical operator documentation or the active TODO ledger.

- `docs/plans/`: early Cuttlefish design, implementation, auth UX,
  security-hardening, and chat-redesign planning archives.
- `docs/superpowers/specs/`: feature design specs.
- `docs/superpowers/plans/`: detailed implementation plans.

Historical archives are not current operator workflow documentation. They may
describe superseded experiments and should not override `README.md`,
`docs/USER_MANUAL.md`, `docs/SPECIFICATION.md`, `docs/ARCHITECTURE.md`, or
`docs/feature_inventory.md`.
