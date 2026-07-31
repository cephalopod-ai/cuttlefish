# Feature Ledger: agent-orchestration-loop-repairs

**feature id:** `agent-orchestration-loop-repairs`

## Inter-agent / inter-department / feedback loop audit + repair (2026-07-31)

**action summary:** Audited the three orchestration loop families the operator
reported problems with — inter-agent (manager delegation, child callbacks,
leader acknowledgement), inter-department (cross-department service requests),
and feedback agent loops (HR critique, board watchdog/reconcilers) — play-tested
them against a live sandbox gateway driven by a scripted engine stub, and
repaired 10 confirmed logic defects. Every repair carries a regression test that
was verified to fail without the fix where the harness allowed it.

**status:** complete for the repaired set (`completed_verified`); residual items
listed under "remaining open items" below are documented, not fixed.

**provenance:** direct — audit performed against the working tree at
`5d7e6a2`, findings confirmed by reading current source and by live play test
(sandbox gateway on port 7788 with an isolated `CUTTLEFISH_HOME`, seven fixture
employees across four departments, and a scripted stand-in for the `pi` engine
CLI speaking its JSON-lines protocol). No history reconstruction involved.

**touched files:**

Inter-agent:
- `packages/cuttlefish/src/gateway/leader-ack-reconciler.ts`
- `packages/cuttlefish/src/sessions/callbacks.ts`
- `packages/cuttlefish/src/gateway/continue-session.ts`
- `packages/cuttlefish/src/gateway/api/routes/session-write.ts` (dead import)

Inter-department:
- `packages/cuttlefish/src/gateway/scoped-token.ts`
- `packages/cuttlefish/src/gateway/api/routes/org.ts`
- `packages/cuttlefish/src/gateway/department-rename.ts`

Feedback loops:
- `packages/cuttlefish/src/gateway/hr-critique-dispatch.ts`
- `packages/cuttlefish/src/gateway/stuck-ticket-watchdog.ts`
- `packages/cuttlefish/src/gateway/ticket-dispatch.ts`
- `packages/cuttlefish/src/gateway/ticket-session-resolver.ts`

Tests:
- `packages/cuttlefish/src/gateway/__tests__/stuck-ticket-watchdog.test.ts` (new
  file — this module previously had no test coverage at all)
- `.../__tests__/leader-ack-reconciler.test.ts`,
  `.../__tests__/session-write-routes.test.ts`,
  `.../__tests__/org-cross-request-route.test.ts`,
  `.../__tests__/scoped-token-forbidden.test.ts`,
  `.../__tests__/board-sync.test.ts`,
  `.../__tests__/hr-steward.test.ts`,
  `.../__tests__/org-department-rename-route.test.ts`

**findings repaired:**

1. **Leader-ack reconciler defeated the one-synthesis delegation barrier**
   (`leader-ack-reconciler.ts`). When an enforced manager fan-out spawns several
   children, the barrier deliberately withholds every child callback from the
   manager until the batch settles — only a `notification` row is written, never
   an assistant turn. But each completed child also arms `leaderAck: pending`,
   and the ack test only counts assistant/user messages, which the barrier
   guarantees cannot exist. So an early-finishing child always timed out, and the
   resulting reminder is dispatched with `bypassManagerDelegationBarrier`, running
   a full manager turn on partial results — then a second synthesis when the slow
   sibling landed. Fixed by skipping the ack clock while the child's parent batch
   is still `waiting_for_children`. Regression test verified to fail without the
   guard.

2. **HTTP-delivered child callbacks could never reopen a dispatched synthesis**
   (`callbacks.ts`, `continue-session.ts`). `resolveManagerDelegationSynthesis`
   has two escape hatches for late/out-of-batch children, both requiring
   `sourceChildSession`. The sink path passes it; the HTTP path
   (`POST /api/sessions/:id/message` with `role:"notification"`) did not, so any
   callback over that hop after synthesis had run resolved to `already_dispatched`
   and was recorded as a banner the manager never reasoned over — a silently
   dropped child result. Fixed by carrying `sourceChildSessionId` across the HTTP
   hop and validating on receipt that the claimed child really is a child of the
   target session, so a forged field cannot reopen someone else's barrier.

3. **Deferred callbacks lost the leader-ack safety net** (`callbacks.ts`). A
   callback parked while background activity drains returned before
   `markLeaderAckPending` ran. The deferral map is process-local and its only
   flush trigger is the engine's drain event, so a crashed engine or a gateway
   restart dropped the callback with no trace and no recovery — the manager waits
   forever. Now the ack is armed before parking, so the reconciler's
   timeout/reminder/escalation path covers it like every other lost callback.

4. **"Escalated to manual human review" paged nobody**
   (`leader-ack-reconciler.ts`). When no escalation recipient exists (no org root,
   or the unresponsive leader *is* the executive), both notifications went into
   session transcripts — including the parent's, which had already ignored two
   contact attempts. Now emits a connector notification so an operator sees it.

5. **Documented agent cross-department path was a guaranteed 403**
   (`scoped-token.ts`). `POST /api/org/cross-request` was caught by the blanket
   non-GET `/api/org/*` deny, while every employee's injected API reference tells
   the agent to call it with its scoped token. Confirmed live before the fix
   (`status=403 Forbidden for session-scoped tokens`) and after
   (`status=201` with a full route trace). Carve-out added, paired with finding 6.

6. **Cross-request had no caller-identity binding** (`api/routes/org.ts`).
   `fromEmployee` and `parentSessionId` were body-claimed, so a caller could
   attribute a request to any colleague (the provider's brief names the requester
   as a trusted peer) and graft work under an unrelated session, including someone
   else's talk thread. A session-scoped caller is now bound to its own employee
   and its own session. Live-verified: impersonation attempt returns 403
   `cross_request_identity_mismatch`.

7. **Cross-requests had no cycle or depth guard** (`api/routes/org.ts`). Each hop
   minted a fresh session with no hop counter and no origin chain, so A→B→A would
   recur until it exhausted the budget. Now walks the parent chain and refuses a
   repeated `(requester → provider)` pair or a chain deeper than 4, returning 409
   with the chain for legibility. Live-verified end to end.

8. **Cross-request traceability was one-sided** (`api/routes/org.ts`). Added
   `requesterSessionId` to `transportMeta.crossRequest`; `fromEmployee` alone is
   an employee name, ambiguous across all of that employee's sessions.

9. **HR critique could attribute a stale verdict to the wrong change**
   (`hr-critique-dispatch.ts`). The HR session is a reused singleton and
   `dispatchWebSessionRun` never rejects — it marks the session `error` and
   resolves — while the critique was read as "the last assistant message" with no
   correlation to this turn. A failed turn therefore handed change B the verdict
   written for change A, which then fed B's human-approval card *and* the
   autonomous dual-model approval prompt. Now anchors on the assistant-message
   count taken before dispatch and checks the settled session status. This is the
   most safety-relevant repair in the set.

10. **Board watchdog and ticket resolver defects** (`stuck-ticket-watchdog.ts`,
    `ticket-dispatch.ts`, `ticket-session-resolver.ts`):
    - The watchdog's alert told the manager tickets were blocked "with no active
      session" and invited re-assignment, but never consulted sessions. Tickets
      blocked on a human model-fallback approval — which routinely outlast the
      one-hour threshold — were quarantined `manualOnly` and a manager agent was
      told to start what would be a duplicate run against live work. Now skips
      tickets whose session is `running`/`waiting`.
    - `dispatchTicket` threw (rather than returning a typed result) when an
      employee's engine was unavailable, escaping the board-worker's
      per-candidate loop and the watchdog's per-department loop and aborting the
      whole tick — one employee pointing at a disabled engine would stop
      dispatching for every department, forever, with only a generic "tick
      failed" log. Now returns `{ ok: false, reason: "engine-unavailable" }`.
    - `sessionMatchesTicket`'s last-resort `candidate.includes(ticket.id)` made
      `ticket-1` match `ticket-10`'s sessions, binding one ticket's feedback to
      another's run and potentially wedging the shorter id `in_progress` behind
      its neighbour's live session. Now requires delimiter-bounded segments.

11. **Department rename skipped case-variant members** (`department-rename.ts`).
    `department` is taken verbatim from YAML, so `department: Platform` inside
    `platform/` is a normal, unprevented shape; the exact-match filter moved the
    directory and board while leaving that employee on the old name — a ghost
    department with no directory whose members are then rejected from their own
    board as foreign-department assignees.

**validation run:**
- `pnpm test` (packages/cuttlefish): **312 files, 2589 passed, 1 skipped, 0 failed**
  (baseline before changes was 311 files / 2573 passed, after building
  `@cuttlefish/contracts`, which the suite requires).
- `pnpm typecheck`: clean. `pnpm lint`: clean (`--max-warnings=0`).
- Live play test on a sandbox gateway (isolated `CUTTLEFISH_HOME`, port 7788,
  scripted engine stub) covering scenarios IA-01 (manager fan-out with
  attribution), IA-06 (agent-initiated cross-department request), IA-08 (HR
  human-only), cross-request impersonation, and the cross-request cycle guard.
  All behaved as designed on the fixed build; IA-06 and the impersonation and
  cycle cases were confirmed broken/unguarded on the pre-fix build.

**remaining open items (audited, NOT fixed):**
- **Tokenless-loopback identity gap (high, pre-existing).** On the shipped
  default (loopback bind, `authRequired` unset) a request with no bearer token
  passes the auth gate with no principal, and both the HR human-only gate
  (`session-write.ts`) and the collaboration management routes treat "no
  principal" as "human". An agent subprocess that simply omits its token can
  therefore still reach HR. Fixing this means deriving "human" from positive
  evidence rather than principal absence — an auth-posture change wider than this
  repair scope, and one that risks the local single-user UX, so it is recorded
  here rather than changed unilaterally.
- **Status-reconciler vs mid_pair false stall (high).** The mid_pair parent is
  held `running` during reviewer/revision phases, but only the *executing* child
  heartbeats, so the status-reconciler's 45s staleness rule force-resets the
  parent to `idle` with a `Stalled:` error and emits a `session:completed` with
  `stalled:true` for any review pass longer than ~1 minute. Needs a parent
  heartbeat (or a phase-aware exemption in both reconcilers); deferred because
  the right fix touches the run loop's heartbeat contract.
- **`boardLock` held across network + LLM I/O (medium-high).** `dispatchTicket`'s
  critical section includes resource fetch and content screening (10s timeout),
  during which every other board writer throws `BoardConflictError` and
  permanently drops its write — including board-sync's `session:completed`
  update, which the orphan reconciler then reads as "worker died".
- **Duplicate `session:completed` per mid_pair run (medium)** advancing
  `maybeAutoDispatchNext` more than once per ticket.
- **mid_pair × enforced delegation collision (medium-high).** For an employee with
  both direct reports and `execution.tier: mid_pair`, the delegation enforcement
  preempts the implementer turn, and the review loop then reviews the fan-out
  announcement as if it were an implementation.
- **Docs drift:** the design doc's promised per-employee "available services" menu
  is unimplemented while `template/CLAUDE.md` claims it ships; the design doc's
  404-for-unknown-service contradicts the implemented (and tested) 422.
