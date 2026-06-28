# TODO Ledger

This ledger is the authoritative list of active documentation/governance TODOs
for this checkout. It intentionally excludes inherited upstream-era TODO notes
and historical planning ideas unless they have been re-opened for Cuttlefish
with current evidence and exit criteria.

Sources: 2026-06-28 six-lens structural audit (STT/PIP/NEG/FSR/ARC/INV prefixes);
2026-06-28 Gemini input/output-path audit (IOP prefix).

| ID | Status | Priority | Area | Brief Description | Evidence | Opened |
|---|---|---|---|---|---|---|
| IOP-CF-002 | closed | critical | security | Discord attachment traversal surface removed by deleting the Discord connector. | `packages/cuttlefish/src/connectors/discord/` removed | 2026-06-28 |
| STT-CF-001 | closed | critical | state-machine | Org change apply now rejects non-approvable states before dispatch. | `gateway/api/routes/org.ts`, `gateway/hr-steward.ts` | 2026-06-28 |
| STT-CF-002 | closed | critical | state-machine | `markExternalOutboxDelivered()` now only transitions rows still in `sending`. | `sessions/registry/external-outbox.ts` | 2026-06-28 |
| FSR-CF-001 | closed | critical | reliability | Daemon config load now exits with a friendly startup error instead of a raw crash. | `gateway/daemon-entry.ts` | 2026-06-28 |
| IOP-CF-001 | closed | high | security | `isAllowedReadPath` now resolves symlinks before root containment checks. | `gateway/files/read-security.ts` | 2026-06-28 |
| IOP-CF-004 | closed | high | security | `isServablePath` now resolves symlinks before managed-storage containment checks. | `gateway/files/storage.ts` | 2026-06-28 |
| STT-CF-003 | closed | high | state-machine | `markExternalOutboxFailed()` is now transactional and status-gated. | `sessions/registry/external-outbox.ts` | 2026-06-28 |
| PIP-CF-001 | closed | high | reliability | Slack handler calls now log synchronous exceptions instead of silently dropping messages. | `connectors/slack/index.ts` | 2026-06-28 |
| NEG-CF-001 | closed | high | concurrency | HR critique session creation now uses a shared promise mutex. | `gateway/hr-steward.ts` | 2026-06-28 |
| FSR-CF-002 | closed | high | reliability | CUTTLEFISH_HOME creation now surfaces a clear permission error. | `gateway/auth.ts` | 2026-06-28 |
| ARC-CF-001 | deferred | high | architecture | Deferred to a dedicated architecture refactor campaign. | `sessions/manager.ts`, `docs/DECISION_LOG.md` | 2026-06-28 |
| IOP-CF-003 | closed | medium | security | Custom upload paths now fail if the target file already exists. | `gateway/files/uploads.ts` | 2026-06-28 |
| PIP-CF-002 | closed | medium | reliability | Email auto-ingest now routes synchronous throws into the async error path. | `email/service.ts` | 2026-06-28 |
| PIP-CF-003 | closed | medium | reliability | HR critique failures now mark the request `error` instead of auto-applying. | `gateway/hr-steward.ts`, `shared/types/org-change.ts` | 2026-06-28 |
| NEG-CF-002 | closed | medium | security | Email auto-ingest now records Authentication-Results and skips SPF/DKIM failures. | `email/normalize.ts`, `email/service.ts`, `email/store.ts` | 2026-06-28 |
| NEG-CF-004 | closed | medium | reliability | Daemon startup now acquires a lock file and refuses a second live instance. | `gateway/lifecycle.ts` | 2026-06-28 |
| FSR-CF-003 | closed | medium | reliability | Node version fallback now logs at error severity with an explicit remediation message. | `gateway/lifecycle.ts` | 2026-06-28 |
| ARC-CF-002 | deferred | medium | architecture | Deferred to a dedicated architecture refactor campaign. | `gateway/hr-steward.ts`, `docs/DECISION_LOG.md` | 2026-06-28 |
| ARC-CF-003 | deferred | medium | architecture | Deferred to a dedicated architecture refactor campaign. | `gateway/auth.ts`, `docs/DECISION_LOG.md` | 2026-06-28 |
| INV-CF-001 | closed | low | invariants | Listable approval types are now explicit in code and documented at the list route. | `shared/types/operations.ts`, `gateway/api/routes/approvals.ts` | 2026-06-28 |
| PIP-CF-004 | closed | low | reliability | Fire-and-forget connector reply deliveries now log failed relay attempts. | `gateway/run-web-session.ts` | 2026-06-28 |
| NEG-CF-003 | closed | low | operator-ux | Email polling now warns when auto-ingest is enabled without any allowlist. | `email/service.ts` | 2026-06-28 |
| NEG-CF-005 | closed | low | reliability | Daemon startup now probes `node-pty` and logs a clear warning when PTY support is unavailable. | `gateway/daemon-entry.ts`, `engines/pty-stream.ts` | 2026-06-28 |
| ARC-CF-004 | deferred | low | architecture | Deferred to a dedicated architecture refactor campaign. | `gateway/api/routes/connectors.ts`, `docs/DECISION_LOG.md` | 2026-06-28 |
