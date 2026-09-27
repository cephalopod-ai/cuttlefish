# Feature Ledger: claude-models-a2a-comms

**feature id:** `claude-models-a2a-comms`

## Claude CLI model refresh and agent-to-agent comms repairs (2026-09-27)

**action summary:** Brought the static Claude catalog in line with what the
Claude CLI (2.1.283) exposes, and repaired confirmed agent-to-agent defects.

- Models: added Claude Opus 5.5 (`claude-opus-5-5`, 1M context) to the setup
  template; offered `xhigh`/`max` on Fable 5.1, Opus 5.5, Sonnet 5 and the
  synthesized Claude registry; made Claude aliases resolve newest-first to a
  registered id (`opus` → Opus 5.5 else Opus 5; new `fable` → Fable 5.1 else
  Fable 5); priced `claude-opus-5-5` ($4/$20) and the `fable` alias, which fell
  through to the $15/$75 unknown-model default; put Opus 5.5 ahead of Opus 5
  and added Fable to the top escalation tier, fixing a stalled Fable worker
  being treated as tier 0 and escalated down to Sol/Sonnet.
- Comms: the management and team session pickers skip inbound A2A task
  sessions, so operator messages cannot run inside a partner's task and be
  projected back to the partner; external A2A cross-requests notify the
  requesting parent session on every settled exit; a refused remote cancel
  reads the task back and settles on its terminal state instead of retrying
  into `error` and dropping the result.
- CI: the empirical-routing test fixture is dated relative to now; its fixed
  2026-06-24 record aged past the 90-day score window on 2026-09-22.

**status:** implemented; validation results recorded below.

**PR #97 review follow-up:** The Claude model and effort-range portion of this
entry is the required feature-ledger record for PR #97, “Add Claude Opus 5.5,
full claude --effort range, and fix Fable escalation downgrade.” The review
follow-up verified that this tracked entry records the feature id, action
summary, touched files, validation, remaining open items, and provenance; no
runtime change was needed to address the ledger-only finding.

**provenance:** direct source inspection, `claude --help` output from the
installed CLI, and a read-only subagent review of the A2A, collaboration and
orchestration paths whose findings were re-verified by reading before patching.
Giles and Dory executables were not available, so this is a manual evidence
entry and does not declare compliance.

**touched files:**
- `packages/cuttlefish/src/cli/setup.ts`
- `packages/cuttlefish/src/cli/__tests__/config-seed.test.ts`
- `packages/cuttlefish/src/shared/models.ts`
- `packages/cuttlefish/src/shared/__tests__/models.test.ts`
- `packages/cuttlefish/src/shared/model-escalation.ts`
- `packages/cuttlefish/src/shared/__tests__/model-escalation.test.ts`
- `packages/cuttlefish/src/sessions/session-patch.ts`
- `packages/cuttlefish/src/sessions/__tests__/session-patch.test.ts`
- `packages/cuttlefish/src/engines/claude-interactive-transcript.ts`
- `packages/cuttlefish/src/engines/__tests__/claude-interactive-transcript.test.ts`
- `packages/cuttlefish/src/collaboration/recipient-resolution.ts`
- `packages/cuttlefish/src/collaboration/__tests__/recipient-resolution.test.ts`
- `packages/cuttlefish/src/gateway/external-a2a-cross-request.ts`
- `packages/cuttlefish/src/gateway/__tests__/org-cross-request-route.test.ts`
- `packages/cuttlefish/src/orchestration/__tests__/runtime.test.ts`
- `CHANGELOG.md`, `README.md`, `docs/feature_inventory.md`
- `.giles/feature-ledger/giles-ledger-0104-claude-models-a2a-comms-20260927.md`

**validation run:** `packages/cuttlefish` full `vitest run` passed 367 files
and 3,291 tests with 3 skipped; `tsc --noEmit` passed; eslint passed on every
changed source and test file. Each comms regression test (5) and the Fable
escalation test were confirmed to fail with the source fix reverted. The web
package, e2e and Windows jobs were not run locally (CI runs them).

For the PR #97 review follow-up, `pnpm typecheck` and `pnpm lint` passed, and a
field-presence check confirmed this entry retains all six required ledger
fields. `pnpm test` passed the contracts and web packages, then reported one
cuttlefish-cli failure before the run was stopped after 164 of 367 CLI files;
the slow execution-authority restart file that was active near the failure was
rerun directly and passed both tests. The incomplete full-suite rerun is
reported as a residual validation limitation rather than as a passing check.

**remaining open items:**
- Existing homes keep their `models.claude` catalog; Opus 5.5 and the wider
  effort range need a manual catalog edit there (documented in README).
- Not changed pending an operator decision: default model, the shipped
  `claude-opus-5` fallback rung, the delegated-authority allowlist (no
  `claude-opus-5-5`), and Haiku 4.5 still advertising effort.
- Comms findings not patched (design decisions): an inbound A2A dispatch that
  fails after its session is linked projects as SUBMITTED indefinitely (the SDK
  overwrites task metadata on throw); talk delegation relays agent text under
  the gateway admin token; no hop limit across A2A gateways; a follow-up sent
  while an approval is pending is acknowledged but not delivered; dual-lane
  passes one `task.model` to both provider families; an external
  INPUT_REQUIRED task has no continuation path.
- Not exercised against a live Claude CLI session or a live A2A peer.
