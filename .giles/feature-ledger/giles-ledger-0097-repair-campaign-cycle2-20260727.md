# Feature Ledger: repair-campaign-cycle2

**feature id:** `repair-campaign-cycle2`

## Multi-lens re-audit + gated repair-defect-campaign, cycle 2 of 2 (2026-07-27)

**action summary:** Re-ran the agent-skills audit (`e3742526/agent-skills`)
against the working tree left by cycle 1, covering security, accessibility,
concurrency, and dead-code lenses. Findings grouped into 5 locality-based
stages and repaired via the `020_repair/repair-defect-campaign` skill: each
stage patched, tested, adversarially reviewed (or exhaustively verified via
grep + clean typecheck for pure deletions), and committed separately.
Cycle 2 of the two-cycle audit→repair run requested for this repo; campaign
now closed.

**status:** cycle 2 complete (`completed_verified`); campaign closed. 1
residual item routed as a documented follow-up (see below).

**touched files (by stage):**
- Group 1 (security-session-scoping — SEC-001, SEC-002): `gateway/scoped-token.ts`,
  `gateway/api/routes/org.ts` (+tests)
- Group 2 (chat-a11y-critical — DESIGN-001/002/003): `components/chat/chat-input-composer.tsx`,
  `components/chat/chat-input.tsx`, `components/chat/chat-messages.tsx`,
  `components/kanban/ticket-card.tsx`, `components/chat/sidebar-session-rows.tsx` (+tests)
- Group 3 (orchestration-concurrency — CONC-001..006): `orchestration/runtime.ts`,
  `orchestration/run-mode.ts`, `orchestration/dual-lane.ts`, `orchestration/store-schema.ts`,
  `gateway/api/routes/cron.ts` (+tests)
- Group 4 (a11y-medium-sweep — DESIGN-004..007): `components/ui/toast.tsx`,
  `components/kanban/create-ticket-modal.tsx`, `hooks/use-keyboard-shortcuts.ts`,
  `hooks/use-go-to-navigation.ts`, `hooks/use-shortcuts-enabled.ts` (new),
  `routes/settings/keyboard-shortcuts-section.tsx` (new), `routes/settings/page.tsx`,
  `routes/not-found-route.tsx` (new), `main.tsx` (+tests)
- Group 5 (deadcode-cleanup-sweep — DEAD-001..012): `bin/cuttlefish.ts`,
  `cli/startup.ts` (wired, not modified), `.github/workflows/ci.yml`,
  `.github/workflows/governance.yml`, `package.json`, `packages/cuttlefish/package.json`,
  `talk/orchestrator-persona.ts`, `gateway/auth.ts`, `gateway/scoped-token.ts`;
  removed: `email/index.ts`, `shared/qdrant.ts`, `components/breadcrumb-bar.tsx`,
  `components/ui/status-chip.tsx`, `components/ui/timestamp.tsx`,
  `scripts/board-add-tickets.mjs`

**validation run:**
- `pnpm typecheck` — green after every stage and at closeout (all 3 packages).
- `pnpm lint` — green after every stage and at closeout (0 warnings, all 3 packages).
- Per-stage targeted `vitest` suites — green; every new regression test that
  could be adversarially verified was confirmed to fail without its fix
  (`git stash` the fix, confirm red, restore, confirm green) before being kept.
- Full `cuttlefish` package suite at closeout: 311/311 files, 2572/2573 tests
  (1 pre-existing unrelated skip; one file flaked on a 20s build-hook timeout
  under parallel load, re-ran clean alone).
- Full `web` package suite at closeout: 114/114 files, 783/783 tests.
- `pnpm test:rdc-r03` (newly wired in Group 5): 11/11.
- Group 5's deletions verified by grep-for-callers before removal, then a
  clean full-repo typecheck after (would surface any missed reference as a
  build error) — deterministic, exhaustive for "is this actually unused."

**defects repaired:** SEC-001, SEC-002, DESIGN-001, DESIGN-002, DESIGN-003,
CONC-001, CONC-002, CONC-004, CONC-005, CONC-006, DESIGN-004, DESIGN-005,
DESIGN-006, DESIGN-007, DEAD-001, DEAD-002, DEAD-003, DEAD-004, DEAD-005,
DEAD-006, DEAD-007, DEAD-008, DEAD-009, DEAD-010, DEAD-011, DEAD-012.

**remaining open items (routed, not stacked here):**
- CONC-003 (Low): lease expiry relies solely on wall-clock timestamps with no
  monotonic cross-check. No equivalent-cost monotonic signal exists for
  in-flight leases the way TMP-CUT-013's boot-generation counter serves
  continuations (leases must survive process restarts, so a per-process
  monotonic clock can't be authoritative); documented as a residual rather
  than forcing a speculative, materially larger change to core lease-expiry
  logic.
- DESIGN-003's underlying `--text-quaternary` token was deliberately left
  untouched globally (~28 decorative call sites — chevrons, kbd hints,
  disabled states — confirmed genuinely decorative via grep) after raising
  it was found to collapse the design system's 4-tier text hierarchy into
  3; only the two explicitly-cited real-content call sites were migrated.
  Flagged in the Group 2 log entry as needing per-site visual review if
  broader compliance is wanted later.
- DFI-004 (carried over from cycle 1, still open): engine/model-registry and
  reportsTo-cycle validation still not enforced at org.ts's persistence
  boundary.

**provenance:** original — re-audit + repair campaign against the working
tree on branch `claude/merge-repair-defects-86m0pw`, each of the 5 groups
committed and validated separately (commits `3093f22`, `c3a4525`, `dc4622c`,
`4071d1c`, `c0779e7`). Cloud/remote session; Giles tool not invoked (waived
per CLAUDE.md); this ledger authored per the repo-local requirement. Full
detail in `docs/logs/session/072026/2026-07-27-repair-defect-campaign-cycle2.md`
and `docs/audits/2026-07-27-agent-skills-multi-lens-audit-cycle2.md` (both
local, git-ignored per this repo's audit/session-log conventions).
