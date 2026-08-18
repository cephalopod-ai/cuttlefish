# TODO Ledger

This is the authoritative active Cuttlefish backlog for this checkout. Closed
defects and completed TODOs are retained, with their evidence, in
[TODO_HISTORY.md](TODO_HISTORY.md); they do not remain in this active table.

| ID | Status | Priority | Area | Item | Source | Opened | Last Evidence | Exit Criteria |
|---|---|---|---|---|---|---|---|---|
| RSP-CUT-001 | open | P1 | repository-posture/branches | Protect `main` with a branch rule or ruleset and required healthy checks. | 2026-08-13 agent-skills audit, finding RSP-CUT-001 | 2026-08-13 | GitHub API: `main` is not protected (`404`) and repository rulesets are empty (`[]`). Requires a GitHub admin settings mutation. See [CONTROL_PLANE_RUNBOOK.md](CONTROL_PLANE_RUNBOOK.md) for the exact ruleset command. | A readback proves `main` protection/rulesets require the intended CI and security checks, restrict destructive/direct updates, and preserve an explicitly documented emergency path. |
| SEC-CUT-016 | open | P2 | security/detection | Land and remotely validate the repaired license-free Gitleaks gate; enable GitHub push protection or explicitly accept its absence. | 2026-08-13 agent-skills audit, finding SEC-CUT-016 | 2026-08-13 | Source installs pinned Gitleaks CLI v8.30.1 from source (no license needed) and runs a full-history scan; **the hosted scan is now green** — run `31923221858` (2026-08-16) succeeded, superseding the pre-repair failure `31611836884`. The earlier failure was the deprecated paid-license `gitleaks-action`; it is replaced by the CLI install. **Only GitHub-native push protection remains off** (`security_and_analysis` is `null`). See [CONTROL_PLANE_RUNBOOK.md](CONTROL_PLANE_RUNBOOK.md). | A maintained scanner executes on push/PR/history (Gitleaks — done, green), the latest hosted scan is green (done), and push protection is enabled or its absence is explicitly accepted. |
| RSP-CUT-002 | open | P2 | repository-posture/releases | Add production-environment protection and branch/tag policy around npm publication. | 2026-08-13 agent-skills audit, finding RSP-CUT-002 | 2026-08-13 | GitHub API reports `npm-production.protection_rules=[]`, `deployment_branch_policy=null`, and `can_admins_bypass=true`; `release-npm.yml` consumes the environment. Requires a GitHub admin settings mutation. See [CONTROL_PLANE_RUNBOOK.md](CONTROL_PLANE_RUNBOOK.md) for the reviewer + branch-policy command. | Readback proves the environment has the selected reviewer/wait/branch-or-tag safeguards, bypass posture is deliberate, and a release rehearsal exercises them. |
| REL-CUT-001 | open | P2 | release/state-reconciliation | Restore npm publication authority, complete v0.23.7, and remove the stale duplicate draft after publication state is verified. | 2026-08-13 agent-skills audit, finding REL-CUT-001 | 2026-08-13 | **Root cause confirmed from failed run `31612431897` logs:** `npm tokens that bypass 2FA are being restricted` followed by `E404 ... you do not have permission`. The `NPM_TOKEN` is not a publish-capable/2FA-compliant automation token — an auth/2FA authority failure, not a missing package (`npm view cuttlefish-cli version` returns `0.23.6`; package exists). CLI manifest is `0.23.7`, tag `v0.23.7` exists, Homebrew is `0.23.6`, duplicate draft release still present. See [CONTROL_PLANE_RUNBOOK.md](CONTROL_PLANE_RUNBOOK.md) for regen-token + rerun + draft-delete steps. | npm, tag, package manifest, release assets, Homebrew formula, and release docs agree on one installable version; duplicate draft disposition is recorded and downstream workflows are green. |
| DEP-CUT-002 | open | P2 | dependencies/dev-tooling | Land the validated `brace-expansion` overrides and confirm Dependabot alert convergence. | 2026-08-13 agent-skills audit, finding DEP-CUT-002 | 2026-08-13 | Overrides are on `main` and pushed: `package.json` pins `brace-expansion@<2.0.0` → `1.1.18` and `>=5.0.0 <5.0.9` → `5.0.9`; frozen install, full/prod audits, lint, tests, and build pass with zero advisories (green on `80157f6`). **Cannot confirm Dependabot alert 15 state** — the alerts API returns `403` (token lacks `security_events` scope); must be checked in the UI or with a scoped token. See [CONTROL_PLANE_RUNBOOK.md](CONTROL_PLANE_RUNBOOK.md). | Full dependency audit has no unaccepted high advisory, production audit stays clean, lint/tests pass, and Dependabot alert 15 is closed or covered by a governed exception. |

These three items await an explicit implementation task (they are analysis
findings; no source was modified this run). The control-plane items above
(`RSP-CUT-001`, `SEC-CUT-016`, `RSP-CUT-002`, `REL-CUT-001`, `DEP-CUT-002`) remain
the blocking backlog; the `PERF-CUT-*` items are non-blocking P3.

## Performance optimization items (analysis-only; awaiting implementation)

These three items were identified in the 2026-08-17 read-only performance
analysis ([audit](audits/2026-08-17-context-perf-analysis.md),
[session log](logs/session/082026/2026-08-17-context-perf-analysis.md),
[Giles ledger 0104](../.giles/feature-ledger/giles-ledger-0104-context-perf-analysis-20260817.md)).
They are code-level optimizations, not control-plane mutations, and are
distinct from the implemented optimizations recorded in
[Giles ledger 0103](../.giles/feature-ledger/giles-ledger-0103-runtime-performance-optimizations-20260811.md)
(which touched `callbacks.ts`, `engine-limits.ts`, and `project-session-tree.ts`).
All three are in `packages/cuttlefish/src/sessions/context.ts` on the per-turn
`buildContext` path. Correctness is unaffected; they are non-blocking.

| ID | Status | Priority | Area | Item | Source | Opened | Last Evidence | Exit Criteria |
|---|---|---|---|---|---|---|---|---|
| PERF-CUT-001 | open | P3 | sessions/context-build | Reuse the existing stat-fingerprinted `loadJobs()` cache (from `cron/jobs.ts`) instead of the per-turn raw `readFileSync`+`JSON.parse` in `buildCronContext()` (`context.ts:636`). | 2026-08-17 context-perf-analysis audit | 2026-08-17 | `buildCronContext()` at `packages/cuttlefish/src/sessions/context.ts:636` calls `fs.readFileSync(CRON_JOBS)` + `JSON.parse(raw)` on every session turn; `loadJobs()` in `packages/cuttlefish/src/cron/jobs.ts:50` already stat-fingerprints the file (`size:mtimeMs`) and clones on cache hit, with identical invalidation semantics (invalidated on `saveJobs`, which emits `cron:reloaded`). | `buildCronContext` renders the same enabled-jobs section via `loadJobs()`; the per-turn read+parse of `cron/jobs.json` is removed; locked-output tests in `sessions/__tests__/context.test.ts` pass unchanged. |
| PERF-CUT-002 | open | P3 | sessions/context-build | Cache `buildEnvironmentContext()` (`context.ts:737`) with the same 30s TTL pattern already used by `buildKnowledgeContext()` (`context.ts:665`), to avoid per-turn `statSync`/`readdirSync` over `~/.openclaw`, `~/.claude`, `~/.codex`, and `~/Projects`. | 2026-08-17 context-perf-analysis audit | 2026-08-17 | `buildEnvironmentContext()` has no cache guard (`grep envCache context.ts` -> none); the analogous `buildKnowledgeContext()` already caches with `KNOWLEDGE_CACHE_TTL_MS = 30_000` under the explicit rationale "runs on every session turn". `noToolEmployee` gate at `context.ts:310` is preserved. | `buildEnvironmentContext` is wrapped in a TTL cache mirroring the knowledge-cache pattern; the rendered environment section is byte-identical within the TTL window; `sessions/__tests__/context.test.ts` passes. |
| PERF-CUT-003 | open | P3 | sessions/context-build | Make `trimContext()` (`context.ts:925`) track length incrementally instead of calling `parts.join("\n\n")` after every substitution, removing the O(n^2) re-join on the over-budget trim path. | 2026-08-17 context-perf-analysis audit | 2026-08-17 | `trimContext` rejoins all parts after each section->summary swap; up to 18 sections (`grep -c "sections.push" context.ts` -> 18) x up to 18 re-joins of a ~100K-char prompt. Within-budget path returns after one join (unaffected); only the over-budget path is improved. | `trimContext` preserves identical selection order (OPTIONAL then STANDARD, last-first) and early-exit semantics; the within-budget output is byte-identical and the over-budget output is byte-identical; `sessions/__tests__/context.test.ts` passes. |

These five entries require a GitHub/npm control-plane mutation that the
sandbox blocks. `SEC-CUT-015`, `SEC-CUT-017`, `ARC-CUT-008`, `OPS-CUT-001`,
and `TST-CUT-004` met their exit criteria and moved to
[TODO_HISTORY.md](TODO_HISTORY.md). `TST-CUT-004` is now satisfied: the
scroll-resize repair is on `main` and the GitHub-hosted CI is green on
`80157f6` (run `31923221899`): `build`, `typecheck`, `unit-tests`, `windows`,
`e2e`, `Run Gitleaks Scan`, and `giles` all report `success`. The exact,
copy-pasteable commands to close the remaining control-plane items are in
[CONTROL_PLANE_RUNBOOK.md](CONTROL_PLANE_RUNBOOK.md).
