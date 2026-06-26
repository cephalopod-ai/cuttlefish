# Structure & Convention Compliance

## Governing Authority

Governing authority is repo-declared with Giles present:

- `AGENTS.md` declares `docs/audits/`, `docs/logs/`, top-level `logs/`, `.giles/`, `governance/logs/`, and `state/` as git-ignored local artifacts.
- `docs/INDEX.md` says audit and session logs are local-only unless explicitly published.
- `.gitignore` enforces the local-artifact boundary.
- `giles repo-check /home/ericl/Work/vscode/public_share/cuttlefish --format pretty` passed with `finding_count: 0` on 2026-06-25.

The doc-stewardship skill's Giles default wants tracked summaries under
`docs/logs/session/`; this repository currently declares the entire `docs/logs/`
tree local-only. This pass preserves the repo contract and writes durable tracked
summaries directly under `docs/`.

## Findings

| ID | Rule / Giles Code | Location | Status | Severity | Tier | Recommended Action | Authority Needed |
|---|---|---|---|---|---|---|---|
| STRUCT-20260625-001 | Local artifact retention | `.playwright-mcp/` | compliant after staging cleanup | low | A | Keep `.playwright-mcp/` ignored and untracked. | none |
| STRUCT-20260625-002 | Session summary location | `docs/logs/` | drift | medium | B | If the team wants Giles default tracked summaries, update `AGENTS.md` and `.gitignore` together. | human + agent-contract approval |
| STRUCT-20260625-003 | Audit/session raw detail tracking | `docs/audits/`, `docs/logs/` | compliant with repo contract | low | A | Preserve raw local logs; publish only durable summaries. | none |
| STRUCT-20260625-004 | Historical docs volume | `docs/plans/`, `docs/superpowers/` | drift | low | C | Consider a future docs archival/indexing pass if public repo noise becomes a problem. | scoped documentation follow-up |
| STRUCT-20260625-005 | Tooling support dirs | `.claude/`, `.agents/` | unknown | low | C | Review as part of a public-tooling surface audit, not inline documentation stewardship. `.fissure/` is local-only tooling and is ignored. | governance/public-staging follow-up |

## Tier B Routed Items

### STRUCT-20260625-002

Recommended diff, if the repo chooses Giles default tracked summaries later:

```diff
- Both `docs/logs/` and the top-level `logs/` ... are **git-ignored local artifacts**
+ Raw session details under `docs/logs/session/<MMYYYY>/` are git-ignored local artifacts.
+ Monthly summaries under `docs/logs/session/<MMYYYY>-session-summary.md` are tracked durable records.
```

Approval path: update `AGENTS.md`, `.gitignore`, `docs/INDEX.md`, and any Giles
exception/retention policy in one governed patch. This pass did not apply that
change.

## Tier C Follow-Ups

- Historical plan/spec archives can be curated into a smaller public narrative, but doing that safely requires a dedicated review of each retained design document.
- Tooling-specific hidden directories need a public-staging decision: either document why they are public, or move/ignore them with compatibility checks.

## Giles Reconciliation

The latest local `giles repo-check` passes. Remaining non-blocking Giles compliance
todo findings are not suppressed here; they are treated as advisory until a
dedicated Giles reconciliation pass chooses to change repo policy.
