# Feature Ledger: repair-campaign-cycle2-pr-review

**feature id:** `repair-campaign-cycle2-pr-review`

## PR #64 automated review response (2026-07-27)

**action summary:** Addressed 6 automated review findings (chatgpt-codex-connector)
on PR #64 (the cycle-2 repair-defect-campaign PR from ledger-0097), one of
which (P1) was a genuine bug introduced by that cycle's CONC-006 fix and one
(P2) a genuine correctness regression in a scope of that PR (DESIGN-004);
the remaining four were legitimate doc-consistency findings.

**status:** complete (`completed_verified`); PR #64 updated and pushed.

**touched files:**
- `packages/cuttlefish/src/orchestration/runtime.ts` (+test in
  `orchestration/__tests__/runtime.test.ts`)
- `packages/cuttlefish/src/shared/qdrant.ts` (restored),
  `packages/cuttlefish/package.json` (restored `@qdrant/js-client-rest`),
  `pnpm-lock.yaml`
- `packages/web/src/components/ui/toast.tsx` (+test in
  `components/ui/__tests__/toast.test.tsx`)
- `docs/feature_inventory.md`

**findings addressed:**
1. **P1 — CONC-006 reaping active long-running continuations**
   (`orchestration/runtime.ts`): making `recoverStaleDispatchingContinuations()`
   run on the reaper's periodic tick (cycle-2 Group 3) exposed a real bug —
   nothing refreshes a "dispatching" continuation's `updatedAt` while its
   task is actually executing, so any run longer than the stale threshold
   (10 min default) would get its continuation marked `failed` mid-flight,
   and the CAS guard added the same cycle (REL-004/CONC-002) then refuses to
   let the run's eventual real completion overwrite that false failure —
   durable state permanently and incorrectly reports failure for a run that
   succeeded. Fixed by gating the wall-clock staleness check on the
   continuation's allocation no longer being live (reusing the
   `liveAllocationIds` set the function already computes for the orphan
   sweep) — a continuation whose allocation is still held cannot be a
   same-process orphan regardless of elapsed time. The boot-generation check
   is untouched (unconditionally safe: an older boot generation is only
   possible for a continuation left by a process that no longer exists).
   New regression test constructs a runtime with a short reaper interval,
   allocates a task without releasing its lease, seeds a "dispatching"
   continuation already older than the stale threshold, advances fake
   timers past several reaper ticks, and asserts it's still `dispatching`
   with a `running` lease. Adversarially verified (reverted the fix,
   confirmed the new test fails red with the continuation flipped to
   `failed`, restored, confirmed green).
2. **P2 — qdrant.ts deletion contradicted a maintained setup guide**: cycle
   2's Group 5 (DEAD-003) deleted `shared/qdrant.ts` and the
   `@qdrant/js-client-rest` dependency based on zero in-code call sites —
   correct as far as code-reachability grep goes, but it missed that
   `docs/QDRANT_SETUP.md` is a maintained, non-trivial setup guide that
   documents `getQdrantClient()` as *the* supported integration point for
   "wherever vector storage or similarity search is required." This is a
   deliberate, documented extension point with no current caller yet, not
   dead code — deleting it silently breaks the guide (missing-module
   failure for anyone following it). Reverted the deletion: restored both
   the file and the dependency verbatim from the pre-deletion commit.
   DEAD-003 is retracted; the ledger-0097 entry is left as-is (historical
   record of what cycle 2 originally shipped) rather than edited in place.
3. **P2 — toast.tsx pause/resume double-fired across overlapping
   hover+focus**: DESIGN-004 (cycle-2 Group 4) wired `onMouseEnter`/
   `onFocus` to `pause()` and `onMouseLeave`/`onBlur` to `resume()`
   independently. Hovering the card while its dismiss button also had focus
   (a realistic combination — mouse over a toast whose button gets
   tab-focused, or vice versa) let whichever interaction ended first resume
   the timer while the other was still active, and let two interactions
   starting/ending together invoke pause()/resume() twice — double-
   subtracting elapsed time from the remaining duration and leaving two
   overlapping `setTimeout` calls racing to dismiss. Fixed by tracking hover
   and focus as independent flags and only calling `pause()` on the
   transition into "at least one active" and `resume()` on the transition
   back to "none active." New regression test: hover, then focus the
   dismiss button, then un-hover while still focused — asserts still paused;
   then blur — asserts resumes with the correct remaining time. Adversarially
   verified (reverted, confirmed the new test fails red, restored, confirmed
   green).
4. **P2 — CLI startup commands undocumented**: DEAD-002 (cycle-2 Group 5)
   wired `cuttlefish startup enable|disable|status` into the CLI but didn't
   add it to the canonical `docs/feature_inventory.md` CLI section. Added a
   "Startup (systemd) integration" subsection documenting the three
   subcommands and their Linux-only boundary.
5. **P2 — 404 route inventory stale**: DESIGN-007 (cycle-2 Group 4) changed
   the wildcard route from a redirect-to-`/` to a dedicated not-found page,
   but `feature_inventory.md` still described the old redirect behavior.
   Updated the description to match.
6. Codex's summary/wrapper review comment required no separate action
   (covered by items 1-5 above).

**validation run:**
- `pnpm install` (restoring `@qdrant/js-client-rest`, lockfile updated) clean.
- `pnpm typecheck` and `pnpm lint` — green (all 3 packages).
- `orchestration/__tests__/runtime.test.ts` — 23/23 green, including the new
  CONC-006 regression test; adversarially verified.
- `components/ui/__tests__/toast.test.tsx` — 4/4 green, including the new
  hover+focus regression test; adversarially verified.
- Full `cuttlefish` package suite and full `web` package suite — both run
  at closeout (see PR #64 for final CI status).

**remaining open items:** none new; carries forward the residuals already
recorded in ledger-0097 (CONC-003, the `--text-quaternary` residual,
DFI-004).

**provenance:** original — responding to automated PR review
(chatgpt-codex-connector) on PR #64, branch `claude/merge-repair-defects-86m0pw`.
Cloud/remote session; Giles tool not invoked (waived per CLAUDE.md); this
ledger authored per the repo-local requirement.
