# 14 — Authorization, Pairing, and Approval Gates

File `08` covers the core checkpoint gate, reject path, persistence, and
orchestration hold/recovery (`AP-01`–`AP-08`). File `09` covers a basic
pairing round-trip (`ST-07`). This file covers the *authorization* layer
around those gates: who may approve, what scoped agents may not do,
remote-access pairing under `authRequired`, security-hook checkpoints,
org-change proposal binding, decision vocabulary beyond approve/reject,
and session-token hygiene.
File `19` adds the run-local capability cases: own-session checkpoint creation,
direct-child transcript reads, COO message-only follow-up, and explicit
turn-scoped operator authority.
File `20` adds simultaneous valid-authority races, forged membership controls,
arbitration precedence, and semantic FYI/reply/approval indicators.

Safety: use a disposable home and test pairing codes only. Never paste
real operator credentials or live session tokens into prompts, tickets, or
scenario notes.

---

### AZ-01 — Org-change proposal binds to originating chat and needs authorized approval
- Goal: a chat-originated org change appears in both the chat review card and `/approvals`; resolution needs an authenticated operator or the existing explicit bounded delegate path.
- Category: happy path / authorization
- Preconditions: gateway running; a human chat session that can propose an org change (hire/edit/delete path your build exposes).
- Steps:
  1. From chat, propose a small reversible org change (e.g. add a disposable test employee).
  2. Confirm a pending item appears in the chat UI and in `/approvals` for the same decision.
  3. Attempt to resolve it by pasting "approved" prose back into the *agent* chat (or an ordinary scoped agent token without an applicable operator grant).
  4. As operator, approve from `/approvals` (or the authenticated review control).
- Expected: agent prose and ungranted scoped tokens cannot resolve the change; operator approval applies it once; the originating session's card updates; no double-apply. An explicitly eligible delegate may resolve the material-bound linked approval within own/direct-child scope; direct org approve/reject/apply routes remain operator-only. The automated bounded-delegate path is separate below.
- Observe: approver identity and timestamp are recorded on the decision.

### AZ-02 — Operator rejection and revise/defer vocabulary
- Goal: checkpoint decisions are not a boolean — `deferred` and `revised` are real outcomes.
- Category: happy path / delete-undo
- Preconditions: a flow that opens a human checkpoint with multiple allowed options (security PreToolUse gate, email screening checkpoint, or generic `POST /api/checkpoints` test harness).
- Steps:
  1. Trigger a checkpoint; choose **deferred**; confirm the run stays paused and the item remains findable.
  2. Trigger or reuse a checkpoint; choose **revised** with notes; confirm notes persist and the resulting action matches design.
  3. Approve a separate item with decision notes; reject another.
- Expected: each decision badge (`approved` / `rejected` / `deferred` / `revised`) renders distinctly on `/approvals`; notes and resulting actions survive restart; deferred work does not silently expire without saying so.

### AZ-03 — Security PreToolUse / risky Bash becomes a durable checkpoint
- Goal: review-gated engine commands pause for a human instead of executing.
- Category: interruption / authorization
- Preconditions: Claude interactive path with PreToolUse hooks enabled; an employee/session whose `approvalPolicy` / `reviewTriggers` gate a known risky command category; disposable workspace.
- Steps:
  1. Prompt the agent to run a review-gated shell command (use a *harmless* gated pattern your config treats as risky — e.g. a matched prefix that only echoes).
  2. Confirm the command did not execute; a checkpoint appears with command text and trigger categories.
  3. Approve; confirm the intended resulting action (resume / run / skip) matches the checkpoint contract.
  4. Repeat and reject.
- Expected: deny-at-hook, durable checkpoint, senior-security-officer (or configured `securityReviewer`) context when designed; rejection leaves no partial side effect from the blocked command.
- Variations: employee `approvalPolicy: notify` (looser) — risky action may continue with a session notification instead of a hard gate; confirm that mode is explicit and still audited.

### AZ-04 — Inbound untrusted content opens human review, not auto-dispatch
- Goal: email/connector content that fails screening becomes a checkpoint rather than an engine prompt.
- Category: recovery / files
- Preconditions: a test IMAP or connector path; ability to inject a message that fails untrusted-content screening (or an attachment that is unsupported/oversized). Use throwaway inboxes only.
- Steps:
  1. Deliver the failing message/attachment.
  2. Watch `/approvals` and any connector session list — engine must not have already answered.
  3. As operator, approve or reject the review item.
- Expected: human-review checkpoint opens; no automatic agent turn on unscreened content; supported text, when eventually released, is wrapped as untrusted data rather than raw trust.
- If no connector credentials exist, Not executed — environment unavailable.

### AZ-05 — Pairing codes under authentication enabled vs. disabled
- Goal: the remote-access panel's pairing controls match `authRequired`.
- Category: settings / authorization
- Preconditions: ability to toggle gateway authentication in the disposable home's config and restart.
- Steps:
  1. With authentication **disabled**, open the remote-access / pairing panel — "Create pairing code" should be hidden with an explanatory note.
  2. Enable authentication; restart; from the **local** dashboard create a pairing code; pair a second browser.
  3. From a non-local / unpaired context (if simulable), confirm create is disabled with a "use local Mac dashboard" style hint when `canBootstrapLocal` is false.
  4. Unpair; confirm access is revoked on next request per design.
- Expected: controls never imply pairing works when auth is off; codes expire/reject when stale; paired list is accurate after refresh and restart.

### AZ-06 — Session-scoped token cannot reach operator collections
- Goal: scoped agent credentials stay inside the documented own-session/delegation envelope.
- Category: authorization / boundary
- Preconditions: a running agent session that exposes `CUTTLEFISH_SESSION_TOKEN` only to its engine subprocess (retrieve via a controlled test harness or gateway debug path if one exists for playtests — do not scrape logs for secrets in shared environments).
- Steps:
  1. With the scoped token, attempt operator-wide reads: email collection, knowledge outbox, orchestration holds, skills removal, session archive of *another* session, filesystem discovery outside own attachments.
  2. Attempt allowed own-session operations (status, own attachments, documented delegation).
- Expected: operator-wide routes deny; own-session routes succeed; raw token never appears in model-visible context or UI transcripts.
- If the token cannot be obtained safely, Not executed — environment unavailable; still verify from the human UI that archive/skills-remove controls are operator-facing only.

### AZ-07 — Manager identity binding on employee PATCH
- Goal: a session-scoped caller cannot claim a foreign manager identity.
- Category: authorization
- Preconditions: two managers M1 and M2; a scoped session bound to M1 (or API caller simulating that bind).
- Steps:
  1. As M1-scoped caller, `PATCH` an employee with `managerName: M1` for a legitimate report change (control).
  2. As M1-scoped caller, attempt `managerName: M2` (or another foreign manager).
- Expected: foreign manager claim returns `403`; legitimate self-manager path behaves per product rules; org YAML is not half-written.

### AZ-08 — Concurrent double-decision race on one approval
- Goal: two operators (or two tabs) deciding the same item produce one coherent outcome.
- Category: concurrency / recovery
- Preconditions: a single pending approval; two authenticated browser sessions.
- Steps:
  1. Open the same `/approvals` item in two tabs.
  2. Approve in tab A and reject in tab B as close to simultaneously as possible.
- Expected: exactly one decision wins; the other receives a clear already-decided error; the underlying work is not both resumed and cancelled; queue shows a single terminal state.

### AZ-09 — Approval applies only once; replay is safe
- Goal: replaying an approve request is idempotent enough not to duplicate side effects.
- Category: boundary / recovery
- Preconditions: AZ-01 style org-change or a checkpoint that resumes a session.
- Steps:
  1. Approve the item.
  2. Immediately re-submit the same approve (second click, replayed `POST`, or browser refresh+confirm).
- Expected: no second employee created, no second resume storm; UI shows already-decided; logs may note the replay but work runs once.

### AZ-10 — Disabled orchestration / auth surfaces stay honest under authorization stress
- Goal: turning features off does not leave authorized-looking dead controls.
- Category: settings / empty state
- Preconditions: ability to set `orchestration.enabled: false` and (separately) review `/approvals` with zero pending items.
- Steps:
  1. Disable orchestration; visit `/orchestration` and attempt hold/create actions.
  2. With an empty approvals queue, confirm empty state (not a spinner forever).
  3. Re-enable; confirm authorized operator controls return.
- Expected: disabled = explained; empty = intentional empty state; re-enable restores function without a daemon reinstall.


## Additional automated evidence/authority acceptance fixtures

Added 2026-09-16. These resumable fixtures supplement the standing exploratory
cards; they do not turn the 225-card library into a pass claim. Generic IDs are
local contract IDs, not claimed upstream portable fixture IDs. All use owned
state and inert effects; a canned worker report validates host treatment of that
input, not model semantics or native OS containment.

Preconditions: Node/pnpm versions supported by the checkout, existing dependencies,
and a disposable source copy with isolated effective runtime/instance/OS-home paths.
Prepare normal build dependencies there. Do not use personal lifecycle commands,
accounts, queues, memory, recipients or provider credentials. The fresh-process
fixtures verify effective paths before startup. Races use receipts/barriers.

Run the core fixtures from that copy:

```bash
pnpm --filter cuttlefish-cli exec vitest run src/gateway/__tests__/execution-authority.test.ts src/gateway/__tests__/execution-authority-restart.test.ts src/gateway/__tests__/org-cross-request-route.test.ts src/a2a/__tests__/outbound.test.ts src/orchestration/__tests__/run-mode.test.ts
```

Run client tests with the web package test runner; the built-dashboard fixture
journey is `pnpm exec playwright test e2e/authority-review.spec.ts --reporter=line`
with an owned free loopback port and an existing headless browser. Its API fixtures
are separate from the real core authorization/process tests.

| ID | Resume action / hostile or benign input | Required observation | Executable evidence |
|---|---|---|---|
| CUT-EA-001 | Authenticate a restricted worker; propose fake source/parent/grant metadata. Admit connector work with forged synthesis/grant fields, then preserve a real host barrier on follow-up. | Unrelated parent/access denies with zero prohibited effects; accepted child inherits restrictions; connector identity/prose cannot mint or overwrite host authority/barrier. | `execution-authority.test.ts`: ingress and connector tests |
| CUT-EA-002 | Explicitly grant eligible COO decision scopes through the authenticated operator path; let a separately credentialed restricted child work. | Legitimate delegated flow succeeds; no copied parent token or ambient child operator grant. | Combined `CUT-EA-002/014` core journey |
| CUT-EA-003 | Repeat identical prompt bytes, use the old token/completion, expire at the boundary or change model. | Issuances differ; old token denies; old completion cannot expire a new grant; current policy/lifetime applies. | Grant lifecycle fixture and delegation tests |
| CUT-EA-004 | Remove required Program Manager policy or change its recorded YAML after enqueue/review. | No partial newly created session/grant or prohibited invocation; existing evidence/approval remains; current policy denial is visible. | Missing-policy and changed-policy fixtures |
| CUT-EA-005 | Rewrite resume/action/material, linked org data or handoff bytes; then decide an unchanged bound operation and replay/conflict it. | Rewriting denies before writer/invocation; valid continuation performs one effect; replay acknowledges and conflict preserves the first decision. | Material/linked-reference fixtures; checkpoint/approval tests |
| CUT-EA-006 | Use authenticated real HTTP ingress, pause a durable queue, issue a grant, kill only the owned process, restart, change model and attempt dispatch. | Evidence/grant history survives; actual dispatch denies and effect count stays zero. | Fresh-process restart fixture |
| CUT-EA-007 | Hold capacity, open a checkpoint, change lease or replace a run before releasing a completion/exception. | Pending work/hold remains; stale invocation or completion cannot settle the replacement task. | Capacity/replacement/lease fixtures; existing concurrent-decision tests |
| CUT-EA-008 | Crash the owned gateway after an inert invocation and restart the same temporary DB; acknowledge recovery. | Claimed row is uncertain, original effect is not repeated and resume never re-arms it. | Fresh-process uncertain-outcome fixture |
| CUT-EA-009 | Request read-only work on an incapable adapter; cancel its parent; separately use a live lease with a capable inert adapter. | Protected refusal before invocation; legitimate allocation retains the flag/requirement; native sandbox claims remain unverified. | Boundary fixtures, run-mode capable/incapable tests, Codex argument tests |
| CUT-EA-010 | Reuse employee identity in independent trees; attempt grandchild/unrelated reads/decisions and a replaced child callback. | Own/direct-child policy remains; stale source cannot insert a report, release synthesis or invoke work. | Direct-child/callback fixture; existing artifact/resource guards |
| CUT-EA-011 | Replay known replies/exports, reuse identity with changed material/destination, or lose an acknowledgement after an inert effect. | No second effect; changed identity binding denies/holds; unknown delivery is retained without automatic resend. | Connector fixture; knowledge outbox/webhook tests; existing A2A replay tests |
| CUT-EA-012 | Retain A: "I believed in Santa Claus when I was seven." and B: "I stopped believing in Santa Claus when I was eight."; duplicate/export their history. | Both speakers/stated times remain attributed; no current belief/existence claim and no authority from historical content. | Combined history/compatibility fixture; envelope/run-bundle tests |
| CUT-EA-013 | Retrieve old approval/revocation history, corrupt boundary state or use an unknown version; trim context below essential sections. | Protected execution refuses missing/corrupt required state; history remains readable; binding distinction survives; no token in prompt/export evidence view. | Combined history/compatibility fixture; context/registry tests |
| CUT-EA-014 | Complete operator → distinct child → reviewed delegated checkpoint → authorized continuation; submit a stale displayed UI revision, retain draft, refresh and decide. | Core completion is separate from fixture browser state; review UI echoes revision, reports denial and shows delegated attribution. | Core journey, web chat/page tests and `e2e/authority-review.spec.ts` |
| CUT-EA-015 | Hold actual peer discovery while the authenticated requester is stopped or its destination changes; recover a persisted taskless request with a stopped parent. | No outbound send; durable denial visible. Preserve existing valid partner/service/task ownership, replay and known-task reconciliation. | Federation barrier/recovery fixtures; existing A2A lifecycle/handler/store/outbound tests |

Results and remaining capability/platform/integration limits are recorded in
[TEST_LEDGER.md](../TEST_LEDGER.md) and the
[maintained handoff](../evidence-execution-authority.md). These fixture results do
not establish live signed-in providers, real connector delivery, peer containment,
strict downstream reader compatibility or upstream runtime conformance.
