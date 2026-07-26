# TODO Ledger

This is the authoritative active Cuttlefish backlog for this checkout. Closed
defects and completed TODOs are retained, with their evidence, in
[TODO_HISTORY.md](TODO_HISTORY.md); they do not remain in this active table.

| ID | Status | Priority | Area | Item | Source | Opened | Last Evidence | Exit Criteria |
|---|---|---|---|---|---|---|---|---|
| PLT-007 | open | P2 | cli-ux | `cuttlefish start` on a running gateway silently restarts it instead of no-op; a stray `start` bounces active sessions | LC-04 variation, `docs/test_scenarios/runs/2026-07-25-fable5-smoke.md` | 2026-07-25 | Confirmed 2026-07-25: "Gateway already running — restarting in background", new PID observed | `start` against a healthy gateway leaves the PID unchanged, or LC-04 is amended to document intentional restart semantics with a confirmation/flag |
| PLT-008 | open | P3 | cli-ux | `cuttlefish skills find ""` spawns the npm registry client on an empty query (network/subprocess side effect before validation) | CL-02 branch 4, `docs/test_scenarios/runs/2026-07-25-fable5-smoke.md` | 2026-07-25 | Confirmed 2026-07-25: npm began installing `skills` package on empty-string query | Empty/whitespace query returns a one-line usage error with non-zero exit before any subprocess spawn |
| PLT-009 | open | P2 | cli-ux | `--json` error paths emit prose/empty stdout (`unpair <bogus> --json` → exit 1, empty stdout, prose on stderr), breaking the machine-readable contract | CL-03 step 2, `docs/test_scenarios/runs/2026-07-25-fable5-smoke.md` | 2026-07-25 | Confirmed 2026-07-25: stdout empty, "Paired browser not found" on stderr | Error case emits a JSON object on stdout (status/message) with non-zero exit, verified for every `--json` command |
