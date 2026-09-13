# Agent working practices

Rationale and longer-form guidance that used to sit inline in `AGENTS.md`.
`AGENTS.md` remains the canonical contract; nothing here overrides it. This file
exists so the durable repo facts in `AGENTS.md` are not buried in prose.

## Operating principles

- Prefer the smallest coherent change that satisfies the task and preserves existing
  behaviour. Do not bundle unrelated work or opportunistic cleanup.
- Make failure states visible. Do not hide uncertainty, skipped validation, degraded
  mode, or partial completion.
- Surface conflicting patterns instead of averaging them. Where two conventions
  collide, report the conflict and make the smallest reversible local choice rather
  than inventing a third convention.
- Stop at the task boundary, at a destructive action, or at unresolved ambiguity.
  Report the current state and the next safe step.
- Summarise meaningful tool actions and file changes together with their effect,
  not just the fact that they happened.

## Repository state

- Uncommitted files are repository state, not a failure. Report them as state.
- Severity `info` findings are not automatic failures. Fail only on the configured
  fail conditions.
- Respect documented exceptions. A known, governed exception is reported as covered,
  not rediscovered as a new finding.

## Audit and patch tasks

- For audit tasks, write findings and evidence. Do not patch code unless explicitly
  instructed to.
- For patch tasks, keep changes scoped and avoid opportunistic architecture rewrites.
- Findings must include evidence paths, observed behaviour, expected behaviour, and
  remediation guidance.

## Orchestrator and router files

Router files may grow in the number of registrations they carry, but not in domain
behaviour. An orchestrator or router file may register routes/commands, parse shallow
adapter inputs, call domain services, sequence high-level workflow steps, and
translate service outputs. It must not host business rules, persistence mutation,
validation algorithms, lifecycle/state machines, dedup/merge/repair logic, or
archive/file parsing. New non-routing behaviour belongs in a focused domain module.

## Staged instruction loading

Some tools cap how much of an instruction file they load — a Codex-style
`project_doc_max_bytes` defaults to 32 KiB, and global instructions count toward that
cap. Any rule past the cap is invisible to such a provider, which is why `AGENTS.md`
front-loads its Normative Core. If you are running under a byte-capped provider, set
the cap high enough to load the whole file; if you cannot, treat the Normative Core as
authoritative and open the later sections explicitly. Non-capped providers (e.g.
Claude Code) load the full file and are unaffected.
