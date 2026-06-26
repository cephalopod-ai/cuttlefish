# Decision Log

| ID | Date | Decision | Rationale | Alternatives | Source | Status |
|---|---|---|---|---|---|---|
| DEC-20260625-001 | 2026-06-25 | Keep `.giles/` and generated Giles artifacts local-only. | Public repo readers should not be confused by local compliance sidecars. | Track all Giles outputs; delete local Giles artifacts. | `.gitignore`, `AGENTS.md`, user instruction | accepted |
| DEC-20260625-002 | 2026-06-25 | Preserve public import paths while modularizing large files. | Compatibility matters more than internal file layout. | Rename public modules; force import churn. | modularization plans and tests | accepted |
| DEC-20260625-003 | 2026-06-25 | Do not document generated web-bundle scanner symbols as UI. | Symbols like `${D}` from ignored generated bundles are not product surfaces. | Add fake docs for scanner output. | Giles compliance review | accepted |
| DEC-20260625-004 | 2026-06-25 | Write durable log/audit summaries under tracked `docs/` paths for now. | Current `AGENTS.md` declares `docs/logs/` and `docs/audits/` local-only. | Force-add summaries under ignored trees; change AGENTS policy inline. | `AGENTS.md`, `.gitignore`, `docs/STRUCTURE_COMPLIANCE.md` | accepted |
| DEC-20260625-005 | 2026-06-25 | Avoid repo-wide source-header churn. | No existing active source-header convention; broad headers would add noise. | Add headers to 700+ source files. | `docs/polish/source-header-policy.md` | accepted |
| DEC-20260626-001 | 2026-06-26 | Preserve explicit upstream lineage/license credit while removing obsolete upstream-era or demo-workflow documentation. | Attribution remains required, but historical demo workflow plans should not read as current Cuttlefish operator docs. | Remove required attribution; preserve all historical demo docs. | `README.md`, `packages/cuttlefish/README.md`, `LICENSE`, `docs/UPSTREAM_DIFF_BASELINE.md`, `docs/INDEX.md` | accepted |
