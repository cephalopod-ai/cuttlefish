# A2A Federation

Cuttlefish can expose selected organization services to external agents and
invoke selected services on external A2A peers. This is an interoperability
adapter: Cuttlefish's existing sessions, collaboration messages, queues,
approvals, run records, and artifact lineage remain authoritative.

The implemented protocol surface is A2A 1.0 over HTTP+JSON. JSON-RPC, gRPC,
push notifications, webhooks, and per-employee Agent Cards are not implemented.

## Inbound setup

Inbound federation is disabled by default. Add an explicit public URL, service
allowlist, and one or more partner credentials to `~/.cuttlefish/config.yaml`:

```yaml
a2a:
  enabled: true
  publicUrl: https://gateway.example.com/a2a
  allowedServices:
    - code-review
    - research
  clients:
    - id: partner-a
      token: replace-with-a-long-random-secret
      allowedServices:
        - code-review
  maxInputBytes: 65536
  maxArtifactBytes: 10485760
  pollIntervalMs: 250
```

The public Agent Card is served at `/.well-known/agent-card.json`. The protocol
endpoint is the URL in `a2a.publicUrl`; it normally ends in `/a2a`. Set
`publicUrl` explicitly when the gateway is behind a reverse proxy or bound to a
wildcard address.

The Agent Card contains only services that satisfy all of these conditions:

1. an active employee declares the service in `provides`;
2. the service appears in `a2a.allowedServices`; and
3. for a given caller, the service also appears in that client's optional
   `allowedServices` list.

The first two conditions determine public discovery. The third is enforced on
invocation. Employee identities, local paths, credentials, and internal routing
details are not published.

Partners authenticate to `/a2a` with either `Authorization: Bearer <token>` or
`x-api-key: <token>`. Each token maps to a stable client identity; task lookup,
listing, continuation, cancellation, and idempotency receipts are scoped to
that identity. Use a unique, high-entropy token for every partner and keep the
configuration file private.

## Inbound behavior

An initial A2A message selects an advertised skill and creates a durable A2A
task/context mapping before Cuttlefish dispatches the request. The selected
internal provider receives a normal Cuttlefish collaboration request, and its
session lifecycle is projected back to the A2A task:

| Cuttlefish state | A2A state |
|---|---|
| accepted but not running | `SUBMITTED` |
| active session/job | `WORKING` |
| pending approval or waiting session | `INPUT_REQUIRED` |
| completed response | `COMPLETED` |
| runtime failure/interruption | `FAILED` |
| canceled task/session tree | `CANCELED` |

Supported operations include sending and streaming messages, getting and
listing tasks, continuing an existing task, canceling it, and subscribing to
updates. Task lookup and cancellation survive a gateway restart. Live stream
resubscription is available while the corresponding in-process event stream
still exists; durable polling is the restart-safe recovery path after dispatch
has been confirmed.

Every A2A `messageId` is recorded before dispatch. Repeating the same ID with
the same content replays its existing task after dispatch is confirmed; reusing
it with different content is rejected. If the gateway restarts in the narrow
window between reserving a receipt and durably confirming collaboration-queue
dispatch, Cuttlefish does not risk sending the turn twice: it stops any mapped
session work, persists the A2A task as `FAILED`, and tells the caller to retry
with a new `messageId`. Later repeats of the ambiguous ID replay that failed
task. This applies to initial messages and follow-ups.

Tasks that share an authenticated caller and A2A `contextId` retain the first
linked Cuttlefish session as their canonical context root. Root selection and
task linkage occur atomically, so simultaneous first tasks converge on the same
group without merging contexts owned by different callers.

Text and structured-data parts become bounded request content. Raw-file parts
use the existing managed upload, screening, and artifact-lineage path. URL parts
are attached as read-only references and are not fetched by the adapter.
Generated files are returned as metadata-only A2A artifacts; local file paths
and file bytes do not cross the federation boundary. Approval details are
reduced to safe operator-input prompts. External peers cannot approve a
Cuttlefish checkpoint or approval through A2A.

## Outbound setup

Each peer is configured independently and confined to exact origins and remote
skill IDs:

```yaml
a2a:
  destinations:
    - id: research-peer
      agentCardUrl: https://peer.example.com/.well-known/agent-card.json
      token: replace-with-the-peer-issued-secret
      credentialType: bearer
      allowedSkills:
        - research
      allowedOrigins:
        - https://peer.example.com
      timeoutMs: 180000
      services:
        - name: external-research
          description: Research through the configured A2A peer
          skillId: research
```

Set `credentialType: x-api-key` when the peer expects that header. The default
is `bearer`. `allowedOrigins` may authorize additional exact origins advertised
by the Agent Card. Redirects are revalidated at every hop, DNS is pinned for the
request, and private/reserved hosts are denied by default. For a local-only
development peer, set `allowPrivateHosts: true` and list its exact loopback or
private origin. Credential-bearing public peers must use HTTPS; cleartext HTTP
is rejected in both configuration validation and the runtime client.

A2A 1.0 permits, but does not require, a server to deduplicate repeated
Send Message operations by `messageId`. Cuttlefish therefore does not replay an
unknown outbound send outcome by default. Set
`messageIdDeduplication: guaranteed` on a destination only when that peer's
operator or contract explicitly guarantees this behavior. The opt-in allows at
most three durable reconciliation attempts under the same message ID; permanent
failures settle visibly instead of retrying forever. Cuttlefish also pins the
canonical Agent Card URL in the request checkpoint and revalidates both that
peer identity and the current deduplication setting before every taskless
replay. Removing the guarantee or reassigning the destination ID fails the
local session without sending the stored request.

The optional `services` mapping makes selected remote skills available through
the existing service directory and `POST /api/org/cross-request`. A normal
internal provider wins if it has the same service name. External requests still
create a local child session and record remote destination, skill, task,
context, status progress, and artifact metadata. Remote raw-file artifacts enter
the managed file and lineage path; text, data, and URL artifact parts are
registered as metadata-only lineage records while their readable content is
included in the child session. Stopping the local child aborts polling and sends
an A2A cancellation to the stored remote task; if completion races cancellation,
the remote terminal response determines the settled local state. Before the
first network attempt, Cuttlefish stores the request and a stable A2A message ID
on the local child session. On gateway startup, a request with a stored remote
task ID resumes polling without sending again. A pre-task-ID request is replayed
only when its destination was explicitly configured with
`messageIdDeduplication: guaranteed`; otherwise an unknown outcome fails visibly
without a second send. The checkpointed Agent Card URL must still match the
current destination and the current configuration must retain the guarantee.
Under that opt-in, cancellation requested before task identity is durable:
recovery obtains the task identity with the same message ID and then sends one
coalesced cancellation path. Abrupt crashes and graceful gateway restarts
preserve eligible checkpoints and their run-ledger ownership.
Duplicate recovery attempts in one process coalesce, and remote progress/result
messages use deterministic local row IDs so replay after a crash does not
duplicate them. Sessions created by an older build without either a task ID or
the durable request checkpoint remain non-recoverable and fail visibly during
the ordinary stale-session sweep.

## Outbound operator API

The authenticated operator API exposes these routes:

| Route | Purpose |
|---|---|
| `GET /api/a2a/outbound/:destination/card` | discover and validate the configured peer |
| `POST /api/a2a/outbound/:destination/messages` | send or continue a message |
| `POST /api/a2a/outbound/:destination/messages:stream` | send and relay A2A updates as SSE |
| `GET /api/a2a/outbound/:destination/tasks/:taskId` | inspect a remote task |
| `POST /api/a2a/outbound/:destination/tasks/:taskId:cancel` | cancel a remote task |

Message bodies require `skillId` and `message`, with optional `taskId`,
`contextId`, `returnImmediately`, and `historyLength`. Session-scoped gateway
tokens cannot use these operator routes.

## Interoperability evidence and limits

The boundary has been exercised against the official A2A TCK's HTTP+JSON 1.0
Agent Card, status/error, data-model, and transport suites: 42 selected checks
passed and 30 transport-inapplicable checks were skipped. It was also exercised
bidirectionally with the official Python A2A SDK test peer; Cuttlefish discovered
the peer's card, selected its allowlisted skill, sent a task, and received the
completed result. These are targeted interoperability checks, not a claim of
full TCK conformance.

MADA's currently published implementation advertises the A2A JSON-RPC binding,
whereas this first Cuttlefish binding is HTTP+JSON. Direct MADA interoperability
therefore requires a future JSON-RPC transport adapter or an HTTP+JSON-capable
MADA endpoint. The `x-api-key` credential form is already supported for peers
that use MADA's API-key convention.
