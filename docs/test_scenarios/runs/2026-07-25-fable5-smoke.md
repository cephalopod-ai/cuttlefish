# Playtest Run — 2026-07-25 — Fable 5 smoke pass

First entry in the append-only `runs/` history (directory created by this
run, per the adopted replay workflow). Full-detail evidence lives in this
file; local-only pointers exist under `docs/audits/072026/` and
`docs/logs/session/072026/` per `PLAYTEST_EXECUTION.md`.

## Run header

- Runner model: Claude Fable 5 (`claude-fable-5`)
- Agent harness: Claude Code 2.1.198 (VS Code extension, non-interactive session)
- App-side model configuration: engine `claude` (interactive PTY,
  Max-subsidized); session default resolved to Sonnet 5 · Medium
- Variable under appraisal: runner (new model driving the repo); app commit
  and app-side config held constant
- Date: 2026-07-25
- Target repo commit: `d768c43` (cuttlefish-cli v0.23.6, clean tree)
- Library version: none declared (README has no version table — gap noted)
- Pass shape: Smoke / first day (01 → 02 → 10 per README) plus opportunistic
  riders LC-06/07/08
- Environment: macOS (Darwin 25.5.0), Node v24.13.0, pnpm 10.6.4;
  disposable `CUTTLEFISH_HOME` under the session scratchpad
  (`cf-home-PTRUN-20260725`), gateway port 8899; run marker `PTRUN-20260725`
- Run type: Baseline (first per-card durable record; the 2026-07-23 full
  audit's per-card statuses are archived in a git-ignored directory and are
  not recoverable for comparison)

## Deviations from card steps (sanctioned, recorded)

- A live operator gateway was running on port 8888 (PID 23398, `daemon-entry.js`,
  uptime 3 days) from this checkout's `dist/`. Per the library's binding rails
  it was never touched. Consequences:
  - LC-01's literal `pnpm install && pnpm setup && pnpm cuttlefish start` was
    not run because `pnpm start`/the CLI wrapper trigger a rebuild that would
    swap `dist/` under the running operator daemon. The prebuilt `dist`
    (v0.23.6, matching HEAD) was invoked directly:
    `CUTTLEFISH_HOME=<disposable> node packages/cuttlefish/dist/bin/cuttlefish.js …`
  - Gateway port set to 8899 via `config.yaml` (LC-06 variation exercises
    exactly this).
- Browser cards ran through Playwright-driven headless Chromium (real DOM
  interaction, screenshots captured), not the fixture-backed Playwright suite.

## Card results

| Card | Status | Confirmation | Notes |
|---|---|---|---|
| LC-01 | Pass (adapted) | Confirmed | Setup probes engines with sign-in warnings; idempotent re-run; dashboard loads; first-run onboarding wizard (5 steps) is the initial state |
| LC-02 | Pass | Confirmed | All 14 routes render intentional content; `/chat`→`/`, `/logs`→`/activity`, unknown routes land on `/`; zero console errors, zero stuck loaders |
| LC-03 | Blocked | — | Requires an installed-but-unauthenticated engine; de-authenticating the operator's real engines is out of bounds |
| LC-04 | Partial | Confirmed | Core Pass: stop/status/restart truthful, restart detached (PPID 1 `daemon-entry.js`), polite double-stop. Variation Fail → PLT-007 |
| LC-05 | Not executed | — | Needs a mid-conversation session to kill; bounded engine spend this pass |
| LC-06 | Pass | Confirmed | Start refuses: "Port 8899 is occupied by PID …, but no Cuttlefish PID file exists"; `status` reports error, never claims foreign port |
| LC-07 | Pass | Confirmed | `list` shows the single instance w/ correct port+home; `create`/`remove` refuse with explanations, exit 1; second `start` spawns no second daemon (but see PLT-007) |
| LC-08 | Pass | Confirmed | Bad YAML → error names file, line:col, caret excerpt; user's file preserved; unknown key + wrong-typed port both named with valid range |
| CH-01 | Pass | Confirmed | Onboarding completed (portal name `PTRUN Operator`); Assistant chat; card's exact prompt; Sonnet 5 · Medium identity visible; response listed the *disposable* home's real files (`start2.log`, `config.yaml.bak` — corroborated against filesystem, not self-report) |
| CH-02 | Partial | Confirmed | Branch 1 only (empty-send rider): empty Enter produces no message. Branches 2–6 not executed |
| CH-03–CH-08 | Not executed | — | Beyond smoke scope |
| CL-01 | Pass | Confirmed | Bare invocation → usage; help on all advertised commands; `restart` help documents the detached claim; `--version` 0.23.6; help exit 0 |
| CL-02 | Partial | Confirmed | Typo → "Did you mean start?"; bogus flag/extra arg/missing arg → clear one-liners, exit 1. Empty-query branch Fail → PLT-008; unicode branch not executed (bounded network use) |
| CL-03 | Partial | Confirmed | `unpair --json` → `{"devices": []}`, clean stderr; `pair --json` → valid JSON (code `VB9B-EEDD-9XMD`, TTL 299s, self-expired). Error branch Fail → PLT-009 |
| CL-04 | Pass | Confirmed | Stopped daemon: `status`/`list` honest; `pair`/`unpair` fail instantly (0s, no socket hang) with actionable message, exit 1; `skills list` works offline by design |
| CL-05, CL-06 | Not executed | — | Concurrency and environment-seam branches; bounded pass |

Library size for context: 20 files / 225 cards. Executed or partially
executed this pass: 12 cards; Blocked: 1; Not executed (declared): the
remainder of the smoke files' cards and all files 03–09, 11–20.

## Findings

### PLT-007 — `start` on a running gateway silently restarts it (Medium)

- Card: LC-04 variation ("start when already started — expect polite no-op
  or clear 'already running' message").
- Confirmation: Confirmed. Repro: with the gateway running,
  `cuttlefish start` → `Gateway restart helper started with PID …` /
  `Gateway already running — restarting in background.` The gateway bounced
  (new PID observed via `status`).
- Impact: a stray/scripted duplicate `start` interrupts active sessions with
  no confirmation. On an operator gateway this is a live-session outage.
- Expected per card: no-op with "already running"; restart only via
  `restart`.
- Recommendation: product decision — either make `start` a no-op when
  healthy (align with card) or update the card if restart-on-start is
  intentional; if intentional, require `--restart` or a confirmation.
- Exit criterion: `start` against a healthy running gateway leaves the PID
  unchanged (or the card is amended to document restart semantics).

### PLT-008 — `skills find ""` spawns the registry client on an empty query (Low)

- Card: CL-02 branch 4.
- Confirmation: Confirmed. Repro: `cuttlefish skills find ""` → npm begins
  installing/executing the `skills` registry package (network + npm cache
  side effect) instead of rejecting the empty query client-side.
- Impact: no input validation before a network/subprocess action; violates
  the card's "no partial side effects from failed invocations".
- Exit criterion: empty/whitespace query returns a one-line usage error,
  exit non-zero, before any subprocess spawn.

### PLT-009 — `--json` error path emits prose/empty stdout (Medium)

- Card: CL-03 step 2 ("the error should also be JSON").
- Confirmation: Confirmed. Repro: `cuttlefish unpair bogus-device-id --json`
  → exit 1, stdout empty, `Paired browser not found` as prose on stderr.
- Impact: scripts consuming stdout get zero parseable output on errors; the
  JSON contract only holds on success paths.
- Exit criterion: error case emits a JSON object (e.g.
  `{"status":"error","message":…}`) on stdout with non-zero exit.

### Notes (not defects)

- N1 (Low): non-TTY `start` stays attached in the foreground serving the
  gateway (boot log to stdout, never returns), while the restart helper and
  presumably TTY start produce a detached `daemon-entry.js` (PPID 1).
  Scripted/CI callers of `start` will hang waiting for exit. Worth either
  documenting or detaching in both modes. (TTY-path detach is Suspicion —
  inferred from the operator daemon's form; only non-TTY was observed.)
- N2 (Suspicion): in CH-01 the agent described its working directory as
  `~/.cuttlefish/` although `CUTTLEFISH_HOME` pointed elsewhere; the listed
  files were the disposable home's (behavior correct, label wrong). Check
  whether the agent-facing context hardcodes `~/.cuttlefish`.
- N3 (Note): onboarding auto-created session #1 ("Hi! I just finished
  setup …"). Verify whether this consumes an engine turn without an explicit
  user send.
- N4 (Note): `/talk` resolves to `/?lane=team` rather than its own route —
  matches the lane design, but the library's route list implies a distinct
  screen.
- Run-quality note: one cleanup command in this pass used an over-broad
  `pkill -f "daemon-entry.*"` pattern behind a guard; the guard held and the
  operator gateway was verified untouched (PID 23398, port 8888, HTTP 200)
  immediately after. Future passes must scope kill patterns to the
  disposable home path.

## Required coverage checklist (this pass)

Covered: first launch/empty state (onboarding + LC-02), primary happy path
(CH-01), invalid input (CL-02, LC-08), settings persistence surface
(config.yaml, LC-08), close/relaunch (LC-04 restart), error recovery
(LC-06, CL-04), edge input (CL-02), navigation (LC-02 all routes).
Not covered this pass (smoke scope): save/delete/undo, interruption,
uploads/export, model switching, failover, inter-agent, authorization,
concurrency, autonomous boundaries, migration, orchestration, manager
handoff, authority collision.

## Comparison with previous run

- Previous: `docs/audits/2026-07-10-…` and the 2026-07-23 full-library
  audit summary. Per-card statuses from those passes are in the git-ignored
  local archive and not durably recoverable → no card-by-card comparison
  possible. This file establishes the durable per-card baseline.
- PLT-006 (closed) claimed `start` reports configuration-load failures —
  consistent with LC-08's observed behavior (regression holding).

## Qualification verdict

- This runner (Fable 5 + Claude Code): **Not yet qualified** — smoke shape
  only. All executed cards Pass/Partial with explained gaps; three defects
  filed (PLT-007..009). Full-library pass required for qualification.
- Cross-runner requirement: **Not met from durable records.** Prior full
  passes exist but without durable per-card, per-runner statuses. Next
  distinct runner should replay this same smoke set (then the full library)
  and record results here for the head-to-head matrix.

## Recommended next pass

1. Full smoke completion by a second, distinct runner model (cross-runner
   matrix seed) — same commit, same disposable-home recipe.
2. LC-03 on a machine/container with an installed-but-unauthenticated
   engine; LC-05 kill-recovery with a seeded two-exchange session.
3. Decide PLT-007 (product) and amend LC-04 or the CLI accordingly — via a
   deliberate library amendment, not a mid-replay edit.
4. Add a library version table to the README so future runs can pin
   "library version" precisely.
