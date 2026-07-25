# Feature ledger - PR #53 recovery after Dependabot auto-close (2026-07-25)

- **Feature id:** `branch-pr-consolidation-2026-07-25` (continuation of [[giles-ledger-0093]])
- **Action summary:** PR #53 ("bump the npm-minor-and-patch group with 15
  updates": `@next/eslint-plugin-next`, `eslint`, `turbo`,
  `typescript-eslint` at the root; `imapflow`, `ws` in
  `packages/cuttlefish`) was already verified safe (green CI) but was
  accidentally auto-closed by Dependabot when a `git merge origin/main
  --no-edit` commit was pushed directly to its branch to try to unstick a
  GitHub `mergeable: UNKNOWN` computation that was stuck for several
  minutes. Dependabot treats non-Dependabot commits on its own branches as
  manual takeover and abandons the PR. Confirmed via operator decision
  (asked, since this crossed from "merge an existing verified PR" into
  "author a new direct change") to recover by applying the same version
  bumps fresh: checked out a new branch off current `main` (post
  #52/#54/#55/#56/#57), ran `pnpm update` for the exact target versions
  from the closed PR's diff, and verified clean before merging. Confirmed
  the "stuck UNKNOWN" issue on subsequent PRs (#55, #56, #57) was transient
  GitHub-side computation lag, not a real problem — later PRs resolved to
  `MERGEABLE` within 10-15s of polling with no branch manipulation needed;
  this workaround should not be repeated on a live Dependabot branch.
- **Touched files:** root `package.json` (`@next/eslint-plugin-next`
  ^16.2.10->^16.2.11, `eslint` ^10.7.0->^10.8.0, `turbo`
  ^2.10.4->^2.10.7 — one patch newer than PR #53's ^2.10.6 since a turbo
  patch released in the interim, still within the grouped update's
  minor/patch policy, `typescript-eslint` ^8.63.0->^8.65.0);
  `packages/cuttlefish/package.json` (`imapflow` ^1.4.7->^1.5.0, `ws`
  ^8.18.0->^8.21.1); `pnpm-lock.yaml`; this ledger.
- **Validation run:** `pnpm typecheck` passed (all 3 workspace packages via
  turbo); `pnpm lint` passed (all 3 packages, `--max-warnings=0`); `pnpm
  test` passed (web: 110 test files / 767 tests; cuttlefish-cli: 309 test
  files / 2,527 tests passed, 1 skipped); `pnpm build` passed. Pre-existing
  `eslint-plugin-react@7.37.5` peer-dependency warning against `eslint@10.x`
  noted (`found 10.8.0`, wants `^3..^9.7`) — already present before this
  bump at `eslint@10.7.0`, not a regression, not fixed here (out of scope;
  no `eslint-plugin-react` release yet declares eslint 10.x support).
- **Remaining open items:** None for this recovery specifically. Same open
  items as [[giles-ledger-0093]] (`GITLEAKS_LICENSE` secret, unreviewed
  Dependabot security alerts) still apply.
- **Provenance:** Direct continuation of the 2026-07-25 branch/PR
  consolidation request; the recovery method (fresh branch + `pnpm update`
  vs. reopening/force-pushing the closed PR) was confirmed with the
  operator via an explicit approval prompt before applying, since it
  changed the nature of the action from "merge a reviewed PR" to "author a
  new equivalent change."
