
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
# CLAUDE.md

The canonical agent contract for this repository is **`AGENTS.md`** at the repo
root. See `AGENTS.md` and follow it. This file adds no rules of its own.

Governance & compliance: this repo follows the governance and control rules under
`governance/`, `control/`, and `docs/INDEX.md`. Refer to `AGENTS.md` for all
governance, validation, and operating rules.

Cloud/remote agents or agents without local Giles/Dory access may ignore Giles
and Dory requirements; those requirements are waived when the tools are
unavailable.
