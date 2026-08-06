# Feature Ledger: settings-preference-resilience

**feature id:** `settings-preference-resilience`

## Settings preference resilience (2026-08-06)

**action summary:** Audited the repository's settings data flow alongside the
session/collaboration contracts and repaired two settings usability failures.
Persisted browser settings now migrate partial notification preference records
and reject malformed collection shapes, so older or damaged local storage does
not break Settings or navigation. The asynchronous onboarding identity sync now
merges into current provider state rather than its mount-time snapshot, so it
cannot roll back preferences changed while the request is pending.

**status:** implemented and locally validated.

**provenance:** direct source inspection and local tests. The operator stated
that Dory, Giles, and agent skills were unavailable; no generated compliance
scan was used and this entry records evidence without declaring compliance.

**touched files:**
- `packages/web/src/lib/settings.ts`
- `packages/web/src/lib/settings.test.ts`
- `packages/web/src/routes/settings-provider.tsx`
- `packages/web/src/routes/settings-provider.test.tsx`
- `.giles/feature-ledger/giles-ledger-0101-settings-preference-resilience-20260806.md`

**validation run:** `pnpm --filter @cuttlefish/web exec vitest run
src/lib/settings.test.ts src/routes/settings-provider.test.tsx
--reporter=verbose` (2 files, 3 tests passed); `pnpm --filter @cuttlefish/web
typecheck` (passed); `pnpm --filter @cuttlefish/web lint` (passed). `pnpm
test` reached 313 passing cuttlefish-cli files (2620 tests passed, 2 skipped)
but failed one unrelated lifecycle port-occupancy assertion in
`lifecycle-stop.test.ts`; Turbo therefore stopped before the full web suite.

**remaining open items:** This was a source-and-unit-test analysis, not a live
multi-engine or browser playtest. Inter-agent delivery, delegation callbacks,
and management-feed projection were not exercised against installed engines.
