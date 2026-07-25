# Feature ledger - second Dependabot batch (PRs #58, #59) (2026-07-25)

- **Feature id:** `branch-pr-consolidation-2026-07-25` (continuation of [[giles-ledger-0093]], [[giles-ledger-0094]])
- **Action summary:** Two additional Dependabot PRs appeared mid-session
  (created 2026-07-25T16:07Z and 16:14Z, outside the original 6 the
  operator asked to resolve): #58 (`postcss` 8.5.17->8.5.18, fully green
  CI) and #59 (a fresh npm-minor-and-patch group, 16 updates: `react`/
  `react-dom` 19.1->19.2, `@playwright/test` 1.58->1.62, `radix-ui`,
  `@tailwindcss/postcss`, `tailwindcss`, `postcss` 8.5.17->8.5.23,
  `@tanstack/react-virtual`, plus the already-bumped
  `@next/eslint-plugin-next`/`eslint`/`turbo`/`typescript-eslint` from
  [[giles-ledger-0094]]). Confirmed with the operator before touching
  these since they were outside the original scope. #59's CI failed two
  e2e specs (`collaboration.spec.ts`, `scroll.spec.ts`); investigated both
  locally on the PR branch: `collaboration.spec.ts` reproduces at a similar
  failure rate on a clean checkout of `main` itself (confirmed via
  `--repeat-each=3`, unrelated to any change in this campaign — a
  pre-existing strict-mode locator race, not something to fix as part of
  this ledger entry); `scroll.spec.ts` failed only because the local
  Playwright browser binary was stale after the 1.58->1.62 bump (`npx
  playwright install chromium` fixed it; 15/15 reruns passed after). CI's
  own e2e rerun of #59 also came back green on the flaky-test-adjacent
  parts, confirming CI-runner timing, not a real regression from the
  React 19.2 bump. Merged #58 first (clean, superseded); #59 then
  conflicted with #58's overlapping `postcss` line in `package.json`
  (both bumped `@playwright/test`/`postcss` from slightly different base
  snapshots) — GitHub reported `CONFLICTING`. Resolved by checking out
  #59's branch locally (no push to the Dependabot ref, to avoid repeating
  the [[giles-ledger-0094]] auto-close mistake), merging `main` in, taking
  #59's newer `@playwright/test` (1.62.0) and `postcss` (8.5.23) versions,
  verifying clean, then opening a fresh PR from a new branch rather than
  force-pushing to the Dependabot branch.
- **Touched files:** root `package.json` (`@playwright/test`
  ^1.58.2->^1.62.0); `packages/web/package.json` (`@tanstack/react-virtual`
  ^3.14.5->^3.14.8, `radix-ui` ^1.6.2->^1.6.7, `react`/`react-dom`
  ^19.1.0->^19.2.8, `@tailwindcss/postcss` ^4.3.2->^4.3.3, `postcss`
  ^8.5.17->^8.5.23 [via #58 then #59], `tailwindcss` ^4.3.2->^4.3.3);
  `pnpm-lock.yaml`; this ledger.
- **Validation run:** `pnpm install --frozen-lockfile` confirmed lockfile
  consistency post-merge; `pnpm typecheck` passed (4 workspace tasks);
  `pnpm lint` passed (`--max-warnings=0`, 3 packages); `pnpm test` passed
  (web: 110 files / 767 tests); `pnpm build` passed (cached, both
  packages). e2e flakiness on `collaboration.spec.ts` and
  `scroll.spec.ts` (browser-binary-only) investigated and attributed to
  causes independent of this dependency bump per above.
- **Remaining open items:** The `collaboration.spec.ts` strict-mode
  locator flake (`getByText(...)` matching both a message bubble and a
  still-populated disabled textarea) is a real, pre-existing test-quality
  issue on `main` — not fixed here, out of scope for a dependency-merge
  ledger entry, but worth a dedicated follow-up (likely needs a more
  specific locator, e.g. scoped to the message list container, or an
  explicit wait for the composer to clear). Same `GITLEAKS_LICENSE` /
  Dependabot-alert items as [[giles-ledger-0093]] still open.
- **Provenance:** Continuation of the 2026-07-25 branch/PR consolidation
  request; handling these two additional PRs was confirmed with the
  operator via an explicit approval prompt since they surfaced mid-session
  and were outside the original 6-PR scope.
