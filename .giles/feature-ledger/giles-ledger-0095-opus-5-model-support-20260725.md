# Feature Ledger: opus-5-model-support

**feature id:** `opus-5-model-support`

## Claude Opus 5 across the model registry, aliases, ladders, and defaults (2026-07-25)

**action summary:** Made `claude-opus-5` a first-class model everywhere Cuttlefish
names a top-tier Claude model. The bare `opus` alias now expands to
`claude-opus-5` instead of `claude-opus-4-8`; the seeded `cuttlefish setup`
registry gains an explicit `claude-opus-5` entry (1M context, effort
low/medium/high/max) alongside the `opus` alias entry, which is relabelled
"Opus (latest alias)" since it tracks whatever the CLI resolves as newest. The
COO's default fallback chain — both the seeded `modelFallback.globalChain` and
the virtual portal executive's `modelPolicy.fallback_chain` — now pins
`claude-opus-5` at Max effort rather than the alias, so the fallback target is
unambiguous in run records. Opus 5 is added to the escalation ladder's top tier
ahead of the alias, to the delegated-human-authority allowlist, to the
interactive-transcript price table, and to the settings model picker; the
onboarding wizard's "Smartest" eyebrow now covers it. `claude-opus-4-8` was
also missing from the price table (it silently fell through to the default
15/75 pair) and is now listed explicitly.

**status:** complete

**touched files:**
- `packages/cuttlefish/src/sessions/session-patch.ts` — `opus` alias → `claude-opus-5`
- `packages/cuttlefish/src/sessions/operator-delegation.ts` — allow `claude::claude-opus-5`; export `HUMAN_DELEGATION_MODELS_LABEL` derived from the allowlist
- `packages/cuttlefish/src/sessions/context.ts`, `gateway/api/routes/session-write.ts`, `gateway/continue-session.ts` — the injected delegation guidance and both 403 bodies now render that derived label instead of a hand-restated model list that had gone stale
- `packages/cuttlefish/src/cli/setup.ts` — seeded `claude-opus-5` registry entry; `opus` relabelled; global fallback chain pins `claude-opus-5`
- `packages/cuttlefish/src/gateway/org-hierarchy.ts` — portal COO fallback pins `claude-opus-5`
- `packages/cuttlefish/src/shared/model-escalation.ts` — tier 2 gains `claude-opus-5`
- `packages/cuttlefish/src/engines/claude-interactive-transcript.ts` — prices for `claude-opus-5` and `claude-opus-4-8`; corrected the current Opus tier (5/4.8/4.7) from 15/75 to 5/25; added the bare `opus`/`sonnet`/`haiku` alias rows, which previously fell through to the 15/75 unknown-model default
- `packages/web/src/routes/settings/settings-config-sections.tsx` — "Opus 5" option
- `packages/web/src/components/onboarding-wizard.tsx` — eyebrow label for `claude-opus-5`
- tests: `sessions/__tests__/session-patch.test.ts`, `sessions/__tests__/operator-delegation.test.ts`, `cli/__tests__/config-seed.test.ts`, `gateway/__tests__/org-hierarchy.test.ts`
- docs: `README.md`, `docs/USER_MANUAL.md`, `docs/feature_inventory.md` (the alias table there also listed two stale expansions — `sonnet` → `claude-sonnet-4-6` and `haiku` → `claude-haiku-4-5-20251001` — corrected to match the code)

**validation run:**
- `pnpm typecheck` — 4/4 tasks pass
- `pnpm test` — **2527 pass, 1 skipped**, 309 test files
- `pnpm lint` — 3/3 tasks pass (`--max-warnings=0`)

**remaining open items:**
- The seeded `opus` registry row and the pinned `claude-opus-5` row now coexist. Anthropic documents the `opus` alias as tracking the newest Opus, so the two are equivalent today; they diverge only if a deployment pins an older CLI.
- The seeded registry keeps both `claude-opus-5` and the `opus` alias entry. A deployment that wants only the pinned id can drop the alias row from its `config.yaml`; no code change is needed.
- Sonnet 5 stays on the standard 3/15 rather than its 2/10 introductory rate (which ends 2026-08-31), because this table feeds execution cost caps and under-reporting is the unsafe direction. Revisit if the table ever becomes date-aware.
- `docs/plans/**` and `docs/test_scenarios/**` still narrate "Opus 4.8" in historical write-ups; left as-is because they record what shipped at the time.

**provenance:** original — authored in a cloud/remote session against branch
`claude/opus-5-hooks-update-y9v742`. Giles/Dory tooling not invoked (waived per
CLAUDE.md for agents without local Giles access); this entry is written directly
per the repo-local feature-ledger requirement. Validation figures above are from
commands actually executed in this session.
