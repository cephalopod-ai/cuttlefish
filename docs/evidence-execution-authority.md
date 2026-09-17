# Evidence and execution authority

Implemented in Cuttlefish on 2026-09-16. Content may inform authorized work
without independently changing its instructions, scope, permissions or approval
requirements. Gateway identity, grants and workflow transitions remain separate
from worker assertions, references and historical decisions.

This is the maintained implementation and operator handoff. Local execution
receipts and session narratives remain under the ignored session-log tree.
Validation results are in [TEST_LEDGER.md](TEST_LEDGER.md); resumable fixture
scenarios are in [scenario file 14](test_scenarios/14-authorization-and-approvals.md).

## Ownership and available contracts

| Owner | Responsibility | Authority limit |
|---|---|---|
| Cuttlefish | Admit transport principals, issue scoped credentials and explicit delegation, bind decisions, allocate work, fence dispatch and delivery | Applies to gateway-controlled operations and supported invocation restrictions |
| External CLI runtime | Execute the admitted turn using its native authentication and tools | Its filesystem, shell, network and credential isolation require separate provider/runtime evidence |
| Upstream guidance | Declarative consumer obligations | Does not issue a Cuttlefish runtime grant |
| Memory/read providers | Retain and retrieve evidence with their own access and retention rules | Retrieved approval records are historical evidence |

Declarative boundary guidance v1.0 was available during inspection. Upstream
runtime schemas, portable fixture IDs and a Gosling implementation handoff were
not established from the available artifacts. Cuttlefish uses independent
version-1 contracts and generic `CUT-EA-*` fixture IDs; upstream conformance is
**unverified**. No new Gosling or Muninn dependency or integration is required.

## Authoritative state and propagation

Inspection corrected three material documentation conflicts: prompt hashes were
described as issuance identity, reviewer prompts/profiles were described as proven
mutation containment, and the org specification/card omitted the existing bounded
delegation exception. Current behavior and the amended inventory/specification/card
take precedence over those historical descriptions and audit closures.

[Shared boundary contracts](../packages/contracts/src/execution-boundary.ts)
have runtime validators. A valid shape does not authenticate its author.

| Record | Host-owned fields | Purpose |
|---|---|---|
| `sessions.execution_boundary` | Version, admitted origin, execution requirement, unique generation, parent generation, cancellation | Preserve origin and attenuate child restrictions independently of `source: web` or persona |
| `queue_items.dispatch_authority` | Version, generation, exact prompt digest, optional delegation issuance, exact producer session/run, bound decision reference | Revalidate the particular queued operation at dispatch |
| `transportMeta.operatorDelegation` | Unique random issuance, session/generation, scopes, issue/expiry time, role/engine/model snapshot, Program Manager YAML revision | Existing explicit operator delegation, with live validation |
| Approval `payload.reviewBinding` | Material digest, target policy and displayed revision | Bind the reviewed transition, including referenced handoff/org-change material |
| Host delivery/recovery records | Queue outcome, connector reply material/destination digests, outbox destination fingerprint and outcome | Distinguish replay acknowledgements, denied effects and uncertain effects |

Registry creation receives trusted ingress options. Scoped child requests derive
parentage from their authenticated session; child requirements can narrow to
`read_only` and cannot widen a read-only parent. Connector metadata is merged
through the host-field preserve/strip policy. A source cannot mint absent grants,
checkpoints, leases, run IDs, fallback state or delivery outcomes by putting them
in `transportMeta`. Boundaries use a dedicated column.

Malformed or unsupported non-null boundary/queue records carry an invalid-state
marker and block dependent dispatch. Legacy null records remain readable; they
do not establish the new guarantee. Old delegation records cannot become live
grants. Legacy unbound approvals require operator/host review and cannot be
resolved with delegated session authority. Duplicate sessions retain evidence
and restrictions with a new history generation, stripping live grant, checkpoint,
run, lease and recovery state. Run-bundle import is unsupported.

## Bounded decisions and dispatch

The existing operator command/structured management path remains the issuance
path. A direct authenticated operator can delegate to the virtual COO or Program
Manager on the existing exact engine/model allowlist. Other roles, quoted prose,
callbacks, connector messages, peer advertisements and shared knowledge cannot
issue a grant. The single-user operator transport does not establish a new
individual identity claim.

An issuance lasts for its turn, with a maximum two-hour lifetime. Identical prompt
bytes receive different issuances. Completion expires only its own issuance;
an old token cannot exercise a later grant. The token's rights intersect the
current stored grant, role/model policy, task generation and ancestry. Program
Manager decisions also require the exact available YAML revision; unavailable
policy produces `operator_delegation_policy_unavailable`. Decisions and result
reads remain confined to the issuing session and its direct children. Employee
reuse and grandchildren do not extend that scope. Child credentials are minted
for the child; parent credentials and delegated operator rights are not copied.

Approval material is canonically hashed at creation and checked again at decision.
Referenced managed handoffs are confined and limited to 2 MiB; org-change material
includes the actual proposed/before/after data and origin/risk policy. A delegated
decision must echo the displayed `reviewedRevision`. It cannot substitute arbitrary
`resumePrompt` or `resultingAction`. Rejection or deferral cannot request a resume.
An operator may revise the continuation through the supported decision path.

The decision and stable queue intent (`checkpoint:<id>` or `fallback:<id>`) commit
in one SQLite transaction. Org file application uses the existing mutex and
revalidates the live approval at the writer; this is not an atomic transaction
across SQLite and filesystem stores. Replaying a known terminal checkpoint or
durable fallback intent acknowledges it without dispatching again; conflicts
leave the first decision intact.

[Dispatch authorization](../packages/cuttlefish/src/gateway/session-dispatch-authorization.ts)
checks current session/ancestor generations, cancellation, capability, allocation,
queue payload/issuance, source attempt and reviewed decision. Ancestry is bounded
to 32 sessions; unknown/missing/cyclic ancestry does not grant unrestricted scope.
A scheduler lease authorizes allocation only. Protected lease-backed work requires
the runtime's current allocation validator. Web and managed dispatch recheck after
awaits, immediately before `engine.run`, including retries and fallbacks. That
synchronous admission is the local invocation boundary; no SQLite transaction
spans an engine or network call. Revocation after invocation cannot undo an effect
already performed, and other processes/native tools are outside this local fence.

Late completions match the current generation and run. Callbacks match the actual
direct child and its current run, including parked callbacks. Stale results cannot
settle a replacement run, release synthesis or clear a human-owned checkpoint.
An ordinary authorized completion may still satisfy the existing declared
workflow condition and enqueue a bounded continuation.

## Source-to-action coverage

“Existing” means preserved source guards with executable repository coverage;
“extended” identifies this change. Test names below refer to source files, not
claims about live accounts or all standing playtest cards.

| Ingress principal / content role | Target and transformation | Durable identity | Authorization owner / first effect | Recovery and test evidence |
|---|---|---|---|---|
| Operator HTTP/dashboard/CLI request; task objective | New or continued local session; resources and context assembled | Session generation, queue ID, prompt digest | Existing principal + extended creation/dispatch services; engine invocation | Authenticated renewal after stop; `CUT-EA-002/003/006/014`, session-write tests |
| Scoped worker API; proposed child task | Actual direct child; inherits restrictions | Parent generation, child generation/token, queue ID | Principal gate + creation/last dispatch; child invocation | Changed parent denies; `CUT-EA-001/009/010/014` |
| Connector transport; screened reference plus requested work | Managed session keyed by admitted connector; context wrapping | Session generation, provider message/session key; in-process queue | Existing connector admission/untrusted-input/send guards + extended metadata/managed dispatch; invocation/reply | No operator issuance; managed pending closures are not new durable restart jobs; dispatcher, auth, connector-policy tests |
| Operator management request versus agent manager claim | Existing collaboration/service recipient routing | Random management/request identity, session lineage, grant issuance | Existing collaboration/manager guards + extended target-scoped grant checks; local child invocation | Employee reuse grants no cross-project decision access; `CUT-EA-001/002/004/010`, collaboration tests |
| Child result/internal HTTP callback; reported evidence | Parent notification and bounded synthesis | Producer session + exact run, queue authority | Callback/continue/notification services; stored notification then invocation | Stale producer denies before insert/dispatch; `CUT-EA-007/010/014`, callback tests |
| Scoped employee or operator cross-request; service brief | Local provider child or configured remote service | Random local request/session identity; external message/task checkpoint | Existing employee/service authorization + inherited local restriction; local invocation or peer send | Restricted external dispatch unsupported and refused; org-cross-request and external-A2A tests |
| Host cron/board automation; admitted schedule/ticket objective | Scheduled managed/board worker, resource attachment | Existing cron run/session key, board ticket, session generation | Existing operator scheduling controls and host dispatcher; invocation/delivery | Durable schedules remain supported without a live chat grant; cron/board tests; native destination delivery unverified |
| Scheduler allocation/continuation; declared workflow step | Role session, workspace/review bundle | Worker/task/coordinator lease + session generation | Existing runtime validator + extended last dispatch; invocation | Stale/missing lease denies; `CUT-EA-007/009`, run-mode/recovery tests |
| Host retry/model fallback; reference handoff | Same task requirement with current engine/model | Run identity, fallback approval/queue intent | Existing retry policy + extended generation/approval/capability guards; invocation | No unrestricted fallback for protected work; checkpoint/approval/engine-environment tests |
| Operator or valid delegate; reviewed decision | Checkpoint resume or linked org change | Approval revision/material, actor kind, stable intent | Decision services + fresh dispatch/org writer; queue insertion then invocation/file write | Atomic local intent; conflict/replay or changed material produces no second/prohibited effect; `CUT-EA-004/005/007/014` |
| Scoped resource/artifact request; reference bytes | Own namespace or allowed direct-child output | Existing managed file/artifact IDs, hashes and producing runs | Existing artifact/resource guards; read/attach | Shared employee does not confer result ownership; scoped-token/resource/artifact tests; broader descendant policy unchanged |
| Operator config/org/skills/scheduling/worktree control | Control-plane mutations or worktree apply | Existing config/change/task/worktree records | Existing principal/control-plane services; first writer | Scoped workers remain denied; org, scoped-token-forbidden, orchestration/worktree tests |
| Host completed run/decision; historical export | Run bundle or optional knowledge sink | Safe evidence boundary, bounded derivation, envelope idempotency key and sink fingerprint | Existing access/export policy + extended outbox checks; file copy or sink emit | Changed destination holds old rows, unknown outcome does not resend; `CUT-EA-011/012/013`, outbox/run-bundle tests |
| Configured A2A partner; peer task/reference advertisement | Allowlisted local service and partner-owned task | Existing partner/task/context/message mapping, local peer origin | Existing A2A auth/ownership/service guards + current destination revision and task recheck after discovery; local invocation or allowed outbound call | Existing replay/restart/changed-peer controls plus `CUT-EA-015` delayed-discovery cancellation/destination denial; A2A lifecycle/store/handler/outbound and cross-request tests; peer runtime enforcement unverified |

The real transport gate is shared by HTTP and WebSocket requests. Domain services
and dispatchers enforce the affected actions; UI visibility is not a second
authorization policy. No new protocol transport, manager-wide resource access or
permission to mutate control-plane configuration is introduced.

## Evidence, skills and historical applicability

Context construction reserves an essential boundary distinction between the
initiating objective, admitted procedural guidance, reference evidence, proposed
actions, observed results and recorded host decisions. Lower-tier truncation
cannot remove it. Screened content is accepted for processing, not promoted to an
operator. Existing admitted skills may support/narrow authorized work; examples,
arguments, supporting files and retrieved inserts cannot raise gateway rights.
Per-run skill dependency pinning and upstream skill-schema conformance are not
established by this contract; existing role-to-skill design decisions remain open.

Callbacks, summaries and bundles carry a safe evidence view with origin, execution
requirement, session/run references and `authority: historical_only`. Knowledge
summaries identify up to 32 available input messages by ID, role, recorded time and
content revision, with total/omitted counts. This is a conservative input set, not
the model's exact reasoning dependencies. Exported decisions carry the recorded
review revision and time; they never reconstruct a live grant. Knowledge envelope
v1 topics remain, with optional payload metadata whose own boundary version is 1.
No strict downstream reader was provided or exercised; such readers must support
these extensions before delivery is considered compatible. No memory ranking,
truth adjudication, retention deletion or write to a memory service is added.

The synthetic historical fixture retains both attributed records:

- A: “I believed in Santa Claus when I was seven.”
- B: “I stopped believing in Santa Claus when I was eight.”

B does not falsify A's earlier autobiographical report. Speaker and stated time
remain distinct from record time. Neither establishes external-world existence or
the speaker's present belief. Similarly, an earlier approved procedure and a later
revocation may both remain useful history; retrieving the old approval cannot
revive the independent revoked grant. See `CUT-EA-012/013`.

## Capability and delivery limits

| Execution path | Implemented boundary | Evidence and limitation |
|---|---|---|
| Codex batch | Advertises read-only capability and supplies the existing restrictive CLI sandbox arguments for protected turns | Actual argument-assembly tests and inert invocation tests; no live native containment test, network isolation or private-file-read guarantee |
| Claude subscription interactive PTY | Existing native integration/authentication/billing path preserved | Existing PTY/billing/environment regressions; required read-only dispatch is unavailable and refused before invocation |
| Codex interactive PTY and other adapters | Ordinary existing invocation remains supported | No advertised read-only capability; protected dispatch fails rather than silently using an unrestricted adapter |
| mid_pair / scheduler reviewer | Host read-only requirement for default protected reviewer/review-bundle or declared read-only workspace | Unsupported adapter fails; existing reviewer replacement/block/degrade policy remains explicit; a separate worktree or prompt is not a sandbox |

Per-turn environment isolation remains the existing engine-environment mechanism,
including concurrent/nested/fallback/native-process coverage. Master credentials
are not copied to worker environments or prompts; child credentials are distinct.
An external engine running as the same OS user may still read credentials or edit
policy/SQLite files directly and bypass gateway APIs. Stronger OS/service isolation
is a separate capability, not proven by signatures, environment filtering or file
modes.

Automatic web-turn connector replies bind run, redacted payload and canonical
destination before send. Known adapter-certified pre-dispatch failures may retry;
missing acknowledgements and ordinary exceptions are uncertain and not repeated.
Changed material under the same run is denied. Managed native connector replies
and explicit connector-send APIs retain current-attempt/access guards but do not
gain this relay's durable deduplication. Connector account/credential revisions are
not represented by the native connector interface; same-name account replacement
and provider-native sends remain limitations.

Knowledge outbox rows bind the current canonical webhook URL plus credential
revision, or the resolved JSONL path. Claiming is destination-filtered before the
batch limit; held old destinations do not block permitted current destinations.
Current export policy is checked again before emit. Expired sending claims, thrown
emitters, missing results, timeouts and ambiguous 5xx outcomes become `uncertain`.
Remote error bodies are not persisted. Known retryable failures retain bounded
backoff. Local receipts cannot guarantee exactly-once external effects.

Outbound A2A adapters compare the admitted destination revision and run a
host-provided task check after peer discovery and immediately before the guarded
outbound call. Local external-service dispatch/replay uses the shared task ancestry,
cancellation, allocation and checkpoint checks; protected read-only peer execution
remains unsupported. Known task polling/cancellation can reconcile an already
committed remote effect. Revoked authority cannot start a fresh taskless replay.
The outbound call is the local dispatch commitment; later revocation cannot undo
a remote effect or prove the peer's containment.

## Operator recovery and validation

`execution_authority_denied` explains stale grants/generations, changed reviewed
material, ancestry/allocation failure or missing read-only capability. Decisions
retain `human`, `operator_delegate` or `autonomous_dual_model` attribution. The
existing review UI echoes the displayed revision, shows core errors and retains
failed decision drafts. An accepted queue intent does not mean an effect completed.

Restart converts claimed running queue rows to `uncertain`, retains their identity
and evidence, revokes turn delegation and pauses the session for reconciliation.
Determine whether the effect occurred before requesting new work. Only an operator
can acknowledge uncertain session recovery through the existing queue-resume path;
an unresolved checkpoint still blocks it. That acknowledgement never re-arms the
uncertain row. Issue a fresh, bounded operation when appropriate. Stopping changes
the task generation; an authenticated operator ordinary turn can renew it while
retaining the restriction. Old children and queued generations remain stale.

Validation uses a disposable source copy, databases/workspaces, scrubbed credentials
and an isolated OS-home fallback. Fresh-process fixtures assert effective paths
before registry/transport lifecycle operations and invoke the real authenticated
gateway with inert effect counters. Deterministic receipts/barriers test restart,
capacity, cancellation and replacement races. The browser test uses the built
dashboard with fixture APIs and a fresh profile; backend grant/dispatch correctness
is established separately. No paid generation, live connector/memory/account,
personal daemon, hosted CI, upstream runtime conformance or Giles compliance scan
is claimed. Remaining engineering decisions are recorded in
[TODO_LEDGER.md](TODO_LEDGER.md).
