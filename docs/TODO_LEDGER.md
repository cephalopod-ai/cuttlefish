# TODO Ledger

This ledger is the authoritative list of active documentation/governance TODOs
for this checkout. It intentionally excludes inherited upstream-era TODO notes
and historical planning ideas unless they have been re-opened for Cuttlefish
with current evidence and exit criteria.

Sources: 2026-06-28 six-lens structural audit (STT/PIP/NEG/FSR/ARC/INV prefixes);
2026-06-28 Gemini input/output-path audit (IOP prefix);
2026-06-28 connector-removal verification audit (CON prefix);
2026-06-28 connector-removal follow-up audit (CRF prefix, merged into CON IDs below);
2026-06-29 architecture audit (ARC-CUT prefix);
2026-06-29 defect repair campaign (TST prefix).

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
| CON-CF-001 | closed | P1 | connector-cleanup | Discord and Telegram sections were removed from the web settings UI, defaults were retargeted to Slack, and the regression test was updated. | `packages/web/src/routes/settings/settings-connectors-section.tsx`, `packages/web/src/routes/settings/settings-constants.ts`, `packages/web/src/routes/settings/settings-connectors-section.test.tsx` | 2026-06-28 |
| CON-CF-002 | closed | P1 | compatibility | Legacy `connectors.discord`/`connectors.telegram` config keys are now stripped during config load so startup continues with supported connectors only. | `packages/cuttlefish/src/shared/config.ts`, `packages/cuttlefish/src/shared/__tests__/config.test.ts` | 2026-06-28 |
| CON-CF-003 | closed | P2 | connector-cleanup | Stale Discord/Telegram comments and dead type references were removed from backend session helpers and the web sidebar/settings surfaces. | `packages/cuttlefish/src/sessions/manager.ts`, `packages/cuttlefish/src/sessions/rate-limit-handler.ts`, `packages/cuttlefish/src/shared/config.ts`, `packages/web/src/components/chat/sidebar-session-helpers.ts`, `packages/web/src/routes/settings/settings-constants.ts` | 2026-06-28 |
| INV-CF-CRF-003 | closed | P2 | invariants | `notifications.connector` now validates against configured connector inventory, and `notifications.channel` without an explicit connector now fails unless the default Slack target is actually configured. | `packages/cuttlefish/src/shared/config-schema.ts`, `packages/cuttlefish/src/shared/__tests__/config.test.ts` | 2026-06-28 |
| ARC-CUT-001 | open | medium | architecture | Orchestration domain imports the gateway API aggregate and session-dispatch layer — creates a boundary violation and a real module cycle. | `orchestration/run-mode.ts:5-6`, `orchestration/dual-lane.ts:4`, `gateway/api.ts:23-33` — source-evidenced by 2026-06-29 architecture audit | 2026-06-29 |
| ARC-CUT-002 | open | medium | architecture | `runWebSession()` is a gateway god object owning turn execution, org hierarchy escalation, stall leadership, rate-limit fallback, connector reply, TTS, and knowledge export. | `gateway/run-web-session.ts` — source-evidenced by 2026-06-29 architecture audit | 2026-06-29 |
| TST-CUT-001 | open | medium | testing | Pre-existing test failures in `ticket-dispatch-route.test.ts` (5 tests) and `route-hardening.test.ts` (1 test) unrelated to the D1–D8 defect campaign. Confirmed failing on stash baseline before any campaign changes. | `packages/cuttlefish/src/gateway/__tests__/ticket-dispatch-route.test.ts`, `packages/cuttlefish/src/gateway/__tests__/route-hardening.test.ts` | 2026-06-29 |
