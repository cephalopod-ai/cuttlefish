# Cuttlefish Playtest Execution Contract

Use this runbook for a repeatable, evidence-based pass over the scenario cards
in this directory. It supplements the cards; it does not replace their stated
preconditions, safety limits, or expected behavior.

## Before running cards

1. Read `README.md`, `docs/INDEX.md`, this runbook, and the relevant scenario
   card. Use the `audit-playtest-app` catalog workflow when it is available.
2. Record the checkout revision, Node and pnpm versions, engine availability,
   and the exact command or API request used for each exercised card.
3. Create a unique disposable `CUTTLEFISH_HOME` and a free explicit gateway
   port. Never use, stop, pair, unpair, or modify a pre-existing operator
   gateway. Keep fixture artifacts, test employees, jobs, and tickets inside
   that disposable home.
4. Establish the required capability before claiming the relevant card:
   browser control for visual/browser cards; disposable sandbox credentials for
   connector cards; the requested signed-in engines for engine/failover cards;
   and an isolated org/worktree for delegation and orchestration cards.

## Evidence and status rules

Each card must receive one of these statuses in the audit record:

| Status | Meaning |
| --- | --- |
| Pass | The card's stated behavior and its cleanup condition were observed. |
| Fail | The observed behavior contradicts a stated expectation; record a defect. |
| Partial | A named subset ran, but one or more acceptance conditions did not. |
| Blocked | A required capability or safe disposable dependency was unavailable. |
| Not run | The card was deliberately not started; state the unmet prerequisite. |

Do not count an HTTP `200` SPA shell, a source read, a unit test, or the
fixture-backed Playwright suite as a visual browser-card pass. When browser
control is unavailable, report browser interaction and visual accessibility
cards as blocked; do not substitute another UI-driving mechanism without the
operator's approval. Likewise, do not turn missing connector sandboxes into
production connector tests.

For every failure, record: card ID, severity, exact reproduction sequence,
expected and actual behavior, impact, source or endpoint evidence where known,
recommended owner/next change, and a measurable exit criterion. Keep only
confirmed or strongly source-supported defects in `docs/TODO_LEDGER.md`; put
ambiguous observations in the session log with their missing evidence.

## Execution order and safety rails

Run the library in numeric filename order. Run setup, validation, lifecycle,
and cleanup cards first; do not start high-concurrency, destructive,
or connector cards until their isolation preconditions are proven. For any
engine turn, use a harmless deterministic prompt and wait for the terminal
session state before reusing, archiving, or deleting it. For restart checks,
capture the state before and after restart rather than relying on console
output alone.

Treat retries as their own evidence: record whether a duplicate request was
accepted idempotently, rejected clearly, or applied again. This is required
for approvals, checkpoints, cron jobs, skills, orchestration leases, and
session authority-collision cards.

## Completion and reporting

After the pass:

1. Stop gateways started by the pass and remove only the explicitly created
   disposable state. Do not remove a global skill, connector credential, or
   existing instance unless the operator explicitly authorizes it.
2. Write the detailed audit to `docs/audits/YYYY-MM-DD-<slug>.md` and a concise
   handoff to `docs/logs/session/<MMYYYY>/YYYY-MM-DD-<slug>.md`.
3. Add confirmed open defects to the existing `docs/TODO_LEDGER.md`, including
   source evidence and exit criteria. Do not create a second active TODO
   ledger.
4. Update the current month's entry in `docs/INDEX.md`, the documentation
   inventory for this tracked runbook, and the Giles feature ledger. State
   validation commands, failures, skipped checks, and residual risks plainly.

The report must state both the number of cards in the library and the number
of cards that actually ran. A pass with blocked cards is useful evidence, but
it is not a claim that the entire scenario library passed.
