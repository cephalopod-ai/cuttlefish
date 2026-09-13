# Agent Execution Contract

This file is the canonical repo-wide instruction contract for coding, audit,
documentation, and maintenance agents. Adapter files — `CLAUDE.md`, `GEMINI.md`,
`CODEX.md`, `.github/copilot-instructions.md` — may add tool-specific execution
preferences but must not redefine, duplicate, or weaken this contract. On
conflict, `AGENTS.md` wins.

Rationale and longer-form working practices live in
[`docs/agent/working-practices.md`](docs/agent/working-practices.md).

<!-- fleet-tiering-core -->
## Normative Core

Front-loaded so that a provider which truncates long instruction files still
receives the binding rules (a Codex-style `project_doc_max_bytes` defaults to
32 KiB, and global instructions count toward that cap). Later sections
elaborate these rules and must not weaken them.

Precedence: operator task instructions → this Normative Core → later sections
of this file → adapter files (`CLAUDE.md`, `GEMINI.md`, …), which carry
provider-specific execution preferences only.

- **Inspect before modifying.** Read the surrounding code, tests, docs and
  conventions first, and preserve them. Do not invent APIs, imports, paths,
  configuration keys, or commands.
- **Stay in scope.** One coherent task per run; make the smallest coherent
  change; disclose adjacent edits instead of widening scope silently.
- **No fake success.** Never present a stub, placeholder, or canned response as
  working, and never suppress errors to make tests, logs, or reports look clean.
- **Validate before completion.** Run the checks in the Validation section and
  state exactly what passed, failed, or was not run; report work as partially
  validated when only part of the change was verified.
- **Preserve operator work.** Do not delete or overwrite in-progress files, and
  never revert existing changes you were not asked to revert. Uncommitted files
  are repository state, not a failure.
- **Artifact placement.** Durable audit summaries → `docs/audits/`;
  human-authored session/handoff logs → `docs/logs/session/<MMYYYY>/` (NOT the
  repo root and NOT top-level `logs/`, which holds generated telemetry and raw
  evidence). Generated compliance artifacts stay under their generator's output
  path.
- **Evidence, not verdicts.** Scanner output is advisory until a fresh scan
  promotes it; record evidence rather than declaring compliance. Clear a
  blocking finding by fixing the repo or by recording a governed exception in
  `governance/exceptions.yaml`, never by inline suppression.

Nested `AGENTS.md` files (e.g. `docs/AGENTS.md`) add local placement rules for
their subtree and defer to this root.
<!-- / fleet-tiering-core -->

## Repository Contract

Cuttlefish is a lightweight AI gateway daemon that orchestrates professional AI coding
CLIs (Claude Code, Codex, Antigravity). It is a **pnpm + Turborepo TypeScript
monorepo**. It declares `family: application`, `repo_type: service`,
`repo_profile: service_backend` in `governance/repo_config.yaml`.

- Packages: `packages/cuttlefish` (core gateway daemon + CLI, published as `cuttlefish-cli`)
  and `packages/web` (Vite + React dashboard served by the daemon).
- Canonical control surfaces: `AGENTS.md`, `governance/`, `schemas/`,
  `control/`, and `docs/`.
- Purpose: wrap battle-tested engine CLIs behind one daemon and add only routing,
  scheduling, connectors, and the org system — "a bus, not a brain".

### Hard boundaries

- Frozen paths: `control/**` and `governance/**`. Do not edit them unless the
  task explicitly requires it and authority allows.
- Do not modify generated artifacts, vendored files, lockfiles, or
  `packages/*/dist` and `packages/*/out` unless the task requires it.
- Never break the Claude subscription / interactive-PTY billing path (see
  `README.md`, "How the Claude engine works").
- Never commit secrets or `~/.cuttlefish` runtime state.

<!-- GILES:FEATURE-LEDGER:START -->
## Giles feature ledger requirement

Before making implementation, refactor, config, test, or documentation changes, identify the active feature or task.

For each feature-level change, append or update the repo-local Giles feature ledger under:

`.giles/feature-ledger/`

Each ledger entry must record:

- feature id
- short action summary
- touched files
- validation run
- remaining open items
- provenance

Do not claim completion unless the ledger and validation results are updated.
Do not overwrite prior ledger entries.
If reconstructing history from archive/session/audit logs, mark provenance as reconstructed or inferred.
<!-- GILES:FEATURE-LEDGER:END -->
<!-- GILES:DOCS-GOVERNANCE:START -->
## Giles Compliance

- README.md and docs/INDEX.md are required read-order surfaces for repository
  orientation.
- Mermaid diagrams must follow `docs/agent/mermaid-diagram-guidance.md`.
- Documentation patch rules: documentation must be source-grounded; no invented
  or fabricated facts, claims, or docs; verify before writing.
- Treat `.giles/*.yaml` as advisory/discovery-only until validated by a fresh
  Giles scan.
- `.giles` artifacts are local advisory sidecar outputs that may not be
  available without Giles. Canonical compliance data lives under
  `governance/logs/`, while governing repo policy lives under `governance/`,
  `docs/`, and this `AGENTS.md` contract.
- Agents record evidence and do not declare compliance. Only Giles writes or
  refreshes canonical compliance status, and agents must report residual risks,
  skipped checks, and validation failures plainly.
- Cloud/remote agents or agents without local Giles/Dory access may ignore Giles
  and Dory requirements; those requirements are waived when the tools are
  unavailable, and the agent should continue with the repo contract plus visible
  disclosure.
- orchestrator/router file contract: router files are allowed to grow in number
  of registrations, but not in domain behavior.
- Orchestrator/router file contract: orchestrator/router files may only
  register routes/commands, parse shallow adapter inputs, call domain services,
  sequence high-level workflow steps, and translate service outputs. They must
  not host business rules, persistence mutation, validation algorithms,
  lifecycle/state machines, dedup/merge/repair logic, or archive/file parsing;
  new non-routing behavior belongs in focused domain modules.
<!-- GILES:DOCS-GOVERNANCE:END -->

## Documentation Rules

- `README.md` and `docs/INDEX.md` are the orientation surfaces. Keep
  `docs/INDEX.md` aligned with new or renamed operator-facing docs and with the
  current month's log/audit summaries.
- Public CLI/API/UI surfaces are catalogued in `docs/feature_inventory.md`; keep it current.
- Use explicit status language (implemented, partially validated, residual risks),
  and update docs in the same change set as the behaviour they describe.
- Do not claim production readiness for scaffolded surfaces without evidence.

## Compliance

Governance posture for this repo lives under `governance/`:
- `governance/repo_config.yaml`, `governance/repo_manifest.yaml`, and
  `governance/policy.yaml` define the repo type and policy.
- Blocking findings/actions must be remediated or explicitly justified through the
  governed exception workflow (`governance/exceptions.yaml`).
- Informational findings are non-blocking unless a policy explicitly elevates them.
- Keep `family: application`, `repo_type: service`, and `repo_profile: service_backend`
  aligned with the actual repo structure.

## Validation

This monorepo's authoritative checks (run from the repo root):

```bash
pnpm typecheck   # turbo tsc --noEmit across packages
pnpm test        # turbo test (vitest in packages/web, node tests in packages/cuttlefish)
pnpm lint        # turbo lint
pnpm build       # turbo build (also copies packages/web/out -> packages/cuttlefish/dist/web)
```

## Canonical filename

Use `AGENTS.md` (uppercase) as the single canonical instruction file for this repository.

<!-- audit-retention-convention -->
## Audit File Retention

Audits are written under `docs/audits/`. The entire `docs/audits/` tree is a
**git-ignored local artifact** — audit detail files and monthly summaries live only
on the machine that produced them and are not part of the published repo.

Writing a new audit: write `docs/audits/YYYY-MM-DD-<slug>.md` (optionally bucket it
under `docs/audits/MMYYYY/`). Keep findings with evidence paths, observed vs.
expected behavior, and remediation guidance.
<!-- /audit-retention-convention -->

<!-- session-log-convention -->
## Session and Activity Log Retention

Human-authored session logs, activity logs, repair logs, handoff notes, and agent
run narratives belong under `docs/logs/`, not a top-level `logs/`. New session logs
should be written to `docs/logs/session/<MMYYYY>/<YYYY-MM-DD>-<slug>.md`.

Both `docs/logs/` and the top-level `logs/` (generated runtime telemetry such as
`logs/agent-activity.jsonl`) are **git-ignored local artifacts** — they are not part
of the published repo.
<!-- /session-log-convention -->

## Compact checklist

1. Read this file, then `README.md` and `docs/INDEX.md`.
2. Name the one task for this run and the files it touches.
3. Read those files, their tests, and any nested `AGENTS.md` before editing.
4. Make the smallest change that completes the task; do not bundle unrelated fixes.
5. Keep out of `control/**` and `governance/**` unless the task requires them.
6. Write new artifacts to the paths named above; do not create parallel trees.
7. Run `pnpm typecheck`, `pnpm test`, and `pnpm lint`.
8. Report what passed, what failed, what you skipped, and what remains open.
