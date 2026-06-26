# Cuttlefish Frictionless Auth UX Verification Plan

**Pass condition:** the auth UX is considered complete when a local browser loads without interruption, a remote/Tailscale browser can pair once and then use the full app, and an unpaired browser cannot access private Cuttlefish surfaces.

Use an isolated test home and port. Do not use the live installed Cuttlefish home for verification.

## Acceptance Matrix

| Scenario | Expected result |
| --- | --- |
| Local loopback, auth required | Dashboard loads with no visible auth prompt after silent bootstrap |
| Remote/Tailscale-like host, unpaired | Pairing screen appears before private API queries or WebSockets start |
| Remote wrong code | Pairing screen stays visible and shows a clear non-secret error |
| Remote expired code | Pairing screen says the code expired and asks for a new one |
| Remote valid code | Cookie is set, app opens, refresh stays paired |
| Reused pairing code | Rejected |
| Unpaired private API | `401` JSON response |
| Unpaired `/ws` | WebSocket upgrade fails with unauthorized response |
| Paired `/ws` | Socket opens and ping/pong works |
| Logout/forget browser | Cookie clears and pairing screen returns |
| Settings > Pairing device list | Current and newly paired browsers are listed without secrets |
| Settings > Pairing unpair | A selected paired browser disappears after Unpair and cannot use private APIs |
| `cuttlefish pair` | Prints a one-time code and simple steps without exposing the gateway token |
| `cuttlefish unpair` | Lists paired browsers, then revokes the selected browser id without exposing the gateway token |

## Automated Verification

### Backend

Run targeted gateway tests, then full CLI package tests:

```bash
pnpm --filter cuttlefish-cli test -- src/gateway/__tests__/auth-security.test.ts
pnpm --filter cuttlefish-cli test
pnpm --filter cuttlefish-cli typecheck
```

Required backend assertions:

- `/api/auth/state` returns only safe auth metadata.
- `/api/auth/bootstrap` works from loopback and fails from non-loopback.
- `/api/auth/pairing-codes` requires an authenticated/local caller.
- `/api/auth/pair` sets an HttpOnly cookie for a valid code.
- `DELETE /api/auth/devices/:id` revokes one device and clears cookies when revoking the current device.
- Bad, expired, and reused codes are rejected.
- Pairing codes are not logged raw.
- Existing privileged API and WebSocket auth tests still pass.

### Web

Run targeted web tests, then full web checks:

```bash
pnpm --filter @cuttlefish/web test -- src/lib/__tests__/auth.test.ts
pnpm --filter @cuttlefish/web test
pnpm --filter @cuttlefish/web typecheck
```

Required web assertions:

- API calls use `credentials: "include"`.
- First local `401` attempts bootstrap once, then retries once.
- Remote `401` moves the app to pairing-required state.
- `GatewayProvider` does not open a WebSocket before auth is ready.
- Pairing screen handles loading, invalid code, expired code, and success.
- Pairing screen presents two explicit flows: CLI pairing and Web Settings pairing.
- Remote Access panel creates a code and displays expiry.
- Remote Access panel lists paired browsers and can unpair a selected browser.
- Logout clears auth state and returns to pairing.

### Workspace

Run final package-level checks:

```bash
pnpm build
git diff --check
```

Also run a privacy grep before staging or committing:

```bash
git diff | grep -iE 'real-user-name|personal-project-name|private-email@example.com|<absolute-user-path>' || true
```

Expected: no new shipped-code leaks. Use the repo's real privacy-grep pattern locally, but do not add private names or paths to shipped files.

## Manual Smoke Verification

### Local Zero-Friction Flow

1. Start Cuttlefish with auth required on a loopback host.
2. Open the dashboard in a fresh browser profile.
3. Confirm no pairing screen is shown.
4. Confirm chat/session list/settings load.
5. Confirm WebSocket connected indicator or live updates work.

Evidence to record:
- `/api/auth/state` response with no secrets.
- Screenshot of loaded app.
- Note whether a visible prompt appeared.

### Remote/Tailscale Pairing Flow

1. Start Cuttlefish on a network-exposed host with auth required.
2. Open it from a browser context that cannot use loopback bootstrap.
3. Confirm the pairing screen appears.
4. Generate a pairing code from an already-paired/local dashboard.
5. Enter the code remotely.
6. Confirm the app opens and still opens after refresh.

Evidence to record:
- Screenshot of pairing screen.
- Screenshot of Remote Access code state.
- Screenshot of paired app after refresh.

### Security Negative Flow

1. In an unpaired remote browser/client, call:
   - `GET /api/sessions`
   - `GET /api/logs`
   - `GET /api/config`
   - `/ws`
   - `/ws/pty/fake-session`
2. Confirm private HTTP routes return `401`.
3. Confirm WebSockets do not attach.

Evidence to record:
- HTTP status codes.
- WebSocket failure behavior.
- Any log lines, with secrets redacted.

## Visual Verification

Capture screenshots for:

- Pairing screen, desktop dark with the CLI flow open.
- Pairing screen, desktop dark with the Web Settings flow open.
- Pairing screen, mobile light at 390px width with both flow headers visible.
- Bad code state.
- Expired code state.
- Remote Access Settings panel.
- Settings > Pairing paired-browser list with Unpair controls.
- Settings > Pairing after a browser is unpaired.
- CLI `cuttlefish pair` output.
- CLI `cuttlefish unpair` list output.
- CLI `cuttlefish unpair <device-id>` revoke output.

Required visual bar:

- No overlapping text.
- No token shown in screenshots.
- Uses existing Cuttlefish theme tokens.
- Mobile tap targets are usable.
- Pairing UI feels like an intentional first-run state, not a crash/error page.

## Final Evidence Log

When implementation is complete, append a dated result section below with:

- Commit or diff summary.
- Test command outputs summarized.
- Manual smoke result.
- Screenshot paths.
- Any known limitations.

## Results

### 2026-06-24 — Auth UX Implemented And Verified

Diff summary:
- Added backend auth UX endpoints for safe auth state, local bootstrap, local-only pairing-code creation, one-time pair exchange, and logout.
- Added hashed, short-lived, single-use pairing codes.
- Added central web auth helpers, app-level auth gate, remote pairing screen, setup-token fallback, and Settings > Remote Access panel.
- Routed web API calls through credentialed auth fetch and delayed private app/WebSocket startup until auth is ready.

Automated gates:
- `pnpm --filter cuttlefish-cli test` — passed: 116 files, 960 passed, 1 skipped.
- `pnpm --filter @cuttlefish/web test` — passed: 56 files, 578 passed.
- `pnpm --filter cuttlefish-cli typecheck` — passed.
- `pnpm --filter @cuttlefish/web typecheck` — passed.
- `pnpm build` — passed. Vite still reports the existing large `file-view` chunk warning.
- `git diff --check` — passed.
- Shipped package privacy grep — passed with no hits.

Manual smoke, isolated gateway on port 8123:
- Remote `/api/auth/state` returned auth required, unauthenticated, no local bootstrap, network-exposed.
- Local `/api/auth/state` returned auth required, unauthenticated, local bootstrap available.
- Unpaired remote `GET /api/sessions`, `GET /api/logs`, and `GET /api/config` returned `401`.
- Unpaired remote `/ws` and `/ws/pty/fake-session` rejected with `http_401`.
- Local bootstrap returned `200`; local cookie access to `/api/sessions` returned `200`.
- Local pairing-code creation returned `200`.
- Remote pair with valid code returned `200`; paired remote `/api/sessions` returned `200`.
- Paired remote `/ws` opened and responded to ping/pong.
- Reused pairing code returned `401`.
- Logout returned `200`; after logout, remote `/api/sessions` returned `401`.

Screenshots captured in `/tmp/cuttlefish-auth-ux-screenshots/`:
- `pairing-desktop-dark.png`
- `pairing-desktop-light.png`
- `pairing-mobile-dark.png`
- `pairing-mobile-light.png`
- `pairing-token-fallback.png`
- `pairing-bad-code.png`
- `pairing-expired-code.png`
- `remote-paired-after-refresh.png`
- `local-zero-friction-app.png`
- `remote-access-settings-code.png`

Known tradeoffs:
- Pairing-code creation is intentionally local/authenticated only; remote/Tailscale browsers consume codes but do not mint them.
- Invalid and expired codes share a generic error to avoid revealing which codes ever existed; the UI tells the operator to create a fresh local code.
- Direct Tailscale API integration, accounts, and OAuth remain out of scope for this pass.

### 2026-06-24 — Guided Pairing UX Extension Verified

Diff summary:
- Pairing screen now gives explicit three-step instructions and mentions both Settings > Pairing and `cuttlefish pair`.
- Settings section is now Pairing, with code creation plus a paired-browser list marking the current browser.
- Browser auth uses per-device session secrets stored only as hashes; the device list exposes metadata only.
- Added `cuttlefish pair`, which calls the same local `/api/auth/pairing-codes` endpoint used by the web UI.

Automated gates:
- `pnpm --filter cuttlefish-cli test` — passed: 117 files, 965 passed, 1 skipped.
- `pnpm --filter @cuttlefish/web test` — passed: 56 files, 580 passed.
- `pnpm --filter cuttlefish-cli typecheck` — passed.
- `pnpm --filter @cuttlefish/web typecheck` — passed.
- `pnpm build` — passed. Vite still reports the existing large `file-view` chunk warning.
- `git diff --check` — passed.
- Shipped package privacy grep — passed with no hits.

Screenshots captured in `/tmp/cuttlefish-auth-ux-v2-screenshots/`:
- `remote-first-visit-instructions.png`
- `remote-mobile-instructions.png`
- `settings-pairing-before-code.png`
- `settings-pairing-code-created.png`
- `settings-paired-browsers-list.png`
- `remote-wrong-code.png`
- `remote-after-pair-refresh.png`

CLI smoke:
- `cuttlefish pair` printed a single-use code, three pairing steps, and the local dashboard URL.
- Output did not include the gateway auth token.

### 2026-06-24 — Split Pairing And Unpair UX Verified

Diff summary:
- Pairing screen now separates the two operator choices into explicit accordion-style flows: `Pair with Cuttlefish CLI` and `Pair from Web Settings`.
- Added shared `DELETE /api/auth/devices/:id` device revocation.
- Settings > Pairing can unpair individual paired browsers from the device list.
- Added `cuttlefish unpair` to list paired browsers and `cuttlefish unpair <device-id>` to revoke one via the same backend endpoint.

Automated gates:
- `pnpm --filter cuttlefish-cli test` — passed: 117 files, 969 passed, 1 skipped.
- `pnpm --filter @cuttlefish/web test` — passed: 56 files, 581 passed.
- `pnpm --filter cuttlefish-cli typecheck` — passed.
- `pnpm --filter @cuttlefish/web typecheck` — passed.
- `pnpm build` — passed. Vite still reports the existing large `file-view` chunk warning.
- `git diff --check` — passed.
- Shipped package privacy grep — passed with no hits.

Manual smoke, isolated gateway on port 8123:
- Real Tailscale URL returned `canBootstrapLocal: false` and showed the remote pairing gate.
- Settings created a one-time code from an already-paired local browser.
- Remote browser paired with that code and remained paired after refresh.
- Settings listed the local browser and the remote browser with per-row Unpair controls.
- Unpairing the remote browser from Settings removed it from the list; refreshing the remote browser returned to the pairing gate.
- `cuttlefish pair` printed a single-use code and instructions without exposing the gateway token.
- `cuttlefish unpair` listed paired browsers with device ids and copyable revoke commands.
- `cuttlefish unpair <device-id>` revoked the selected remote browser; a follow-up list no longer showed it.

Screenshots captured in `/tmp/cuttlefish-auth-ux-v3-screenshots/`:
- `remote-cli-flow-dark.png`
- `remote-web-settings-flow-dark.png`
- `remote-mobile-light-two-flows.png`
- `settings-pairing-code-created.png`
- `remote-after-pair-refresh.png`
- `settings-paired-browsers-with-unpair.png`
- `settings-after-web-unpair.png`
- `remote-after-web-unpair.png`
