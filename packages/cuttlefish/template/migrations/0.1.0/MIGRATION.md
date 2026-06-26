# Migration: 0.1.0 (Baseline)

This is the initial release of Cuttlefish. No migration steps are needed — fresh installs via `cuttlefish setup` receive everything automatically.

## What's included in the initial template

- `config.default.yaml` — default gateway configuration
- `CLAUDE.md` — operating instructions for the COO persona
- `AGENTS.md` — Codex engine instructions
- `docs/` — architecture documentation (overview, connectors, cron, org, skills, self-modification)
- `skills/` — 10 built-in skills:
  - `management` — org management (hire, fire, promote, delegate)
  - `cron-manager` — cron job CRUD
  - `skill-creator` — create new skills
  - `self-heal` — diagnose and fix gateway issues
  - `onboarding` — first-run setup wizard
  - `migrate` — AI-assisted template migrations
  - `sync` — sync employee conversation context
  - `status` — session status display
  - `new` — reset chat session
  - `find-and-install` — skills.sh marketplace integration

## For future releases

Subsequent versions will include migration steps here (file additions, config changes, schema updates) along with a `files/` directory containing new or modified template files.
