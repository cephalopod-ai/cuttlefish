# Cuttlefish Seamless Security Hardening Plan

**Goal:** harden Cuttlefish's local gateway without making daily use annoying.

**Non-negotiables:**
- Do not use or modify the operator's live `~/.cuttlefish` instance.
- Use isolated worktree: `<repo-worktree>`.
- Use isolated test home: `<isolated-test-home>`.
- Run test gateway on port `8000` only.
- Use TDD: tests fail first, then implementation.
- Verify both security and UX.

## UX contract

Security must feel like:
1. **Local desktop:** open dashboard; no password prompt after first token bootstrap.
2. **CLI/curl:** can use token from `gateway.json`; no copy/paste needed for local scripts.
3. **Remote/Tailscale:** requires auth/device token; unauthenticated requests are rejected clearly.
4. **Risky actions:** normal chat is frictionless; sensitive file reads / exposed network without auth / connector sends get protection.

## Implementation phases

### Phase 1 — Auth foundation

Add gateway auth helpers and request middleware:
- Generate/read a gateway auth token under the active `CUTTLEFISH_HOME`, not real `~/.cuttlefish` during tests.
- Accept auth via:
  - `Authorization: Bearer <token>`
  - secure-ish local cookie for browser UX
  - loopback bootstrap endpoint only when no token exists or when explicitly local.
- Require auth for privileged `/api/*` and `/ws*` when enabled or when binding non-loopback.
- Keep `/api/status` safe/minimal.

Expected files:
- `packages/cuttlefish/src/gateway/auth.ts` new
- `packages/cuttlefish/src/gateway/api.ts` modify
- `packages/cuttlefish/src/gateway/server.ts` modify
- `packages/cuttlefish/src/shared/types.ts` modify config types
- tests under `packages/cuttlefish/src/gateway/__tests__/`

### Phase 2 — Network exposure guardrails

- Default remains `127.0.0.1`.
- If host is `0.0.0.0` or non-loopback and auth is disabled/missing, warn or refuse based on config.
- Add explicit escape hatch: `gateway.insecureAllowUnauthenticatedNetwork: true`.

### Phase 3 — File-read protection

- Keep project browsing convenient.
- Block/redact high-risk paths:
  - `.env*`
  - `~/.ssh/**`
  - `<CUTTLEFISH_HOME>/secrets/**`
  - `~/.claude/**/auth*`, `~/.codex/auth.json`
  - private keys and common token files
- Allow explicit config override only for local authenticated users.

Expected files:
- `packages/cuttlefish/src/gateway/files.ts`
- tests for allowed project file, blocked secret file, redacted sensitive content.

### Phase 4 — Redaction everywhere

Port a compact Hermes-style redactor to TypeScript:
- Vendor token prefixes
- auth headers
- JSON secret fields
- env assignments
- private key blocks
- DB/userinfo URLs

Apply to:
- logger
- `/api/logs`
- connector outbound text
- cron/session error output where low-risk to integrate.

Expected files:
- `packages/cuttlefish/src/shared/redact.ts` new
- `packages/cuttlefish/src/shared/logger.ts`
- relevant tests

### Phase 5 — Risk-based confirmations / hard blocks

Use existing Claude hooks where available:
- hard-block destructive commands and obvious exfil attempts
- surface clear message in session/log
- do not interrupt normal chat

Expected files:
- `packages/cuttlefish/src/gateway/hook-endpoint.ts` or new policy module
- `packages/cuttlefish/src/shared/command-policy.ts` new
- tests

### Phase 6 — Isolated live verification

- Create `<isolated-test-home>/config.yaml`.
- Build from worktree.
- Launch gateway with `CUTTLEFISH_HOME=<isolated-test-home>`, port `8000`.
- Verify:
  - unauthenticated privileged API rejected
  - local bootstrap works
  - authenticated dashboard/API works
  - blocked secret file read
  - allowed normal file read
  - redaction in logs
  - no access to live `~/.cuttlefish`

## Verification checklist

Track in `SECURITY_HARDENING_VERIFICATION.md`.

## Delegation model

- Implementation worker: Cuttlefish Dev persona, TDD only.
- Verification worker: separate Cuttlefish Dev/security reviewer, no code changes unless asked; independently attacks UX/security assumptions.
- Orchestrator owns merge/fix/final verification.
