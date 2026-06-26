# M13 Holds And Runtime Employee Mutation Design Gate

Status: design gate only. No held-team allocation, runtime employee mutation,
automatic requeue, or per-manager authorization implementation is accepted by
this note.

## Scope

This note records the default design position for four M13 concepts that remain
deferred after M12:

- runtime-editable employees;
- TTL-bounded held-team allocations;
- D9 hold semantics versus durable state;
- R18 per-manager authorization.

## Default Position

Held-team allocations must be durable TTL records separate from leases. A hold
reserves eligibility for a bounded time window but must not dispatch workers,
start sessions, create worktrees, or write lease rows. Holds expire
automatically and release their reservation without operator action.

Hold ownership and mutation require an explicit authorization model before any
implementation. R18 is unresolved: no per-manager or per-coordinator auth
boundary currently exists for creating, extending, transferring, or canceling a
hold. Until that model is accepted, all hold implementation remains deferred.

Runtime-editable employees are also deferred. Live org mutation would affect
the gateway org bridge, scheduler worker synthesis, runtime refresh, session
launch authority, and auditability. It needs adversarial review before code
changes because stale worker views and unauthorized mutation could create
incorrect dispatch.

## Required Review Before Implementation

An accepted adversarial review must settle at least:

- D9: exact hold lifecycle, persistence table shape, TTL expiry trigger, and how
  holds interact with queue retry, pause/resume, runtime refresh, and shutdown;
- R18: who may create, inspect, extend, transfer, or cancel a hold, and how that
  authority is represented in API, CLI, dashboard, and audit logs;
- recovery behavior: whether active holds survive corrupt DB quarantine, and
  what operator evidence is surfaced without trusting corrupt state.

Implementation is blocked until those decisions are recorded in the plan and
tests are specified.
