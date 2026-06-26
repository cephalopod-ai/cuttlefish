# Difference Report: Upstream Baseline to Cuttlefish

## Snapshot

- Date: 2026-06-25
- Compared upstream: configured `upstream` remote, branch `main`; this baseline is the direct `repo-makeover/jinn` lineage, which itself descends from original `hristo2612/jinn`.
- Upstream commit: `7d47260f2055d1020fcce1b4546b64bc42d3296b` (`formula: bump to v0.23.3`)
- Local commit compared: `9f877408cd1e42580a853f9e97c5b3a5970af4a3` (`chore: cleanup Playwright MCP artifacts and update documentation`)
- Relationship: local `main` is 244 commits ahead of `upstream/main`; no upstream-only commits were present at fetch time.
- File delta: 504 paths changed, 366 added paths, 138 modified paths, 0 deleted paths.
- Line delta: 58,147 insertions and 15,363 deletions.

Commands used:

```bash
git fetch upstream main
git rev-list --left-right --count upstream/main...HEAD
git diff --shortstat upstream/main..HEAD
git diff --name-status upstream/main..HEAD
git diff --dirstat=files,0 upstream/main..HEAD
```

The counts above compare committed local `HEAD` to `upstream/main`. The current documentation-stewardship working tree changes are intentionally excluded from those counts.

## High-Level Difference Map

| Area | Representative paths | Actual differences |
|---|---|---|
| Governance and agent contract | `AGENTS.md`, `CODEX.md`, `CLAUDE.md`, `GEMINI.md`, `governance/*.yaml`, `schemas/config/*.yaml` | Adds a repo-wide agent execution contract, model-specific pointers, Giles/governance policy files, schema registry files, and compliance metadata. |
| Runtime/tooling | `package.json`, `.npmrc`, `.pnpmrc`, `pnpm-workspace.yaml`, `eslint.config.mjs`, `scripts/*.mjs` | Pins repo tooling to Node 24, moves pnpm-specific runtime pinning into `.pnpmrc`, adds ESLint scripts/config, serializes turbo tests, adds `node-pty` build allowance, and adds helper scripts for CLI launch and spawn-helper repair. |
| Orchestration | `packages/cuttlefish/src/orchestration/**`, `packages/cuttlefish/src/cli/orchestration.ts`, `packages/cuttlefish/src/gateway/api/orchestration-routes.ts`, `packages/web/src/routes/orchestration/page.tsx` | Adds provider-neutral orchestration: adapters, scheduler/runtime, durable store modules, worktree execution, dual-lane runs, recovery/requeue controls, telemetry, CLI commands, HTTP routes, and dashboard UI. |
| Gateway API and server modularization | `packages/cuttlefish/src/gateway/api.ts`, `packages/cuttlefish/src/gateway/api/routes/**`, `packages/cuttlefish/src/gateway/server/**`, `packages/cuttlefish/src/gateway/files/**` | Splits large gateway files into route modules, server transport/static/connector helpers, file upload/read/transfer/attachment modules, and adds focused seam tests. |
| Session persistence and registry modularization | `packages/cuttlefish/src/sessions/registry.ts`, `packages/cuttlefish/src/sessions/registry/**`, `packages/cuttlefish/src/sessions/registry-archives.ts`, `packages/cuttlefish/src/sessions/registry-approvals.ts` | Converts the registry into a facade plus core/schema/migrations/search/sessions/messages/queue/files modules, and adds archive/approval persistence APIs and tests. |
| Engine handling | `packages/cuttlefish/src/engines/**`, `packages/cuttlefish/src/shared/engine-env.ts`, `packages/cuttlefish/src/shared/usage-status.ts` | Adds/refactors engine support and safety around Kiro, Pi, Antigravity, Codex, and Claude interactive PTY handling, including transcript parsing, turn resolution, late recovery, secret-stripped engine environments, and usage status helpers. |
| Security and safety hardening | `packages/cuttlefish/src/shared/ssrf-guard.ts`, `packages/cuttlefish/src/shared/safe-write.ts`, `packages/cuttlefish/src/gateway/internal-auth.ts`, `packages/cuttlefish/src/gateway/manager-auth.ts` | Adds SSRF guard coverage, safe-write helpers, manager/internal auth boundaries, route hardening tests, forced-home deletion guards, and engine environment secret stripping. |
| Dashboard UI | `packages/web/src/routes/**`, `packages/web/src/components/chat/**`, `packages/web/src/components/kanban/**`, `packages/web/src/components/ui/**` | Adds approvals/archive/orchestration pages, modularizes chat page/input/messages/sidebar/settings surfaces, adds room grouping, auth gate, richer Kanban ticket detail UI, and aquatic/nautical avatar selection. |
| Assets | `packages/web/public/avatars/{aquatic,nautical}/64/*.png` | Adds 64px aquatic and nautical avatar packs used by employee/avatar UI. |
| Tests | `packages/cuttlefish/src/**/__tests__/**`, `packages/web/src/**/__tests__/**`, `tests/test_giles_slot.py` | Adds broad coverage for orchestration, gateway routes/files/auth/work, session registry/archive/approval behavior, shared helpers, chat/sidebar/rooms, Kanban, org, and governance/Giles slots. |
| Documentation | `docs/INDEX.md`, `docs/orchestration/README.md`, `docs/feature_inventory.md`, `docs/script-surface-map.md`, `docs/polish/**` | Adds current documentation index, orchestration manual, feature inventory, script-surface safety map, polish reports, known diagnostics, Mermaid guidance, and implementation plans/specs. |

## Notable Behavioral Changes

- The gateway now exposes orchestration control surfaces for queue pause/resume, continuations, dual-lane winner selection/application, recovery requeue, telemetry, artifacts, and run state.
- Board/ticket dispatch can route work through orchestration rather than only direct session execution.
- File handling gained stricter read/upload boundaries, managed serving, caching helpers, transfer handling, and attachment rehoming tests.
- Session data handling expanded to include archives, approvals, partial messages, media/block preservation, prompt excerpts, CWD/status guards, queue pause/replay, and registry search support.
- Engine execution is more defensive around Claude interactive PTY behavior, background activity, late turn recovery, child environment redaction, and missing or unavailable model/provider states.
- The web app gained more operator-facing control panels and was split into smaller component/view-model modules to reduce oversized files.

## Notable Tooling and Contribution Changes

- Current tooling requires Node.js 24.x; this differs from older docs/plans that mentioned Node 22-era setup.
- Linting is now an explicit repo/package validation surface.
- Root `pnpm test` runs turbo tests with `--concurrency=1`.
- The package-local web clean script is cross-platform Node.js instead of shell-only `rm -rf`.
- Governance, compliance, and script-safety metadata are now first-class tracked repo surfaces.

## Public Repo Caveats

- Some retained planning documents under `docs/plans/` and `docs/superpowers/` are historical and may describe earlier architecture assumptions. Current behavior should be taken from `README.md`, `docs/INDEX.md`, `docs/USER_MANUAL.md`, `docs/ARCHITECTURE.md`, `docs/SPECIFICATION.md`, and source/tests.
- Local-only artifacts such as `.giles/`, `docs/audits/`, `docs/logs/`, top-level `logs/`, `governance/logs/`, and `state/` remain intentionally ignored by the repo contract.
- This report is a documentation summary of the committed diff. For exact path-level review, run the commands in the snapshot section.
