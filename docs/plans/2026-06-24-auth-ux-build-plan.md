# Cuttlefish Frictionless Auth UX Build Plan

**End goal:** a non-technical operator can use Cuttlefish securely without understanding tokens, cookies, headers, or network binding.

The finished UX must prove these three flows:

1. **Local Mac:** open the dashboard on loopback and Cuttlefish loads normally, with no visible auth prompt.
2. **Tailscale/new browser:** open the dashboard remotely, see a clear pairing screen, enter a one-time pairing code from an already-paired/local dashboard, and then use the full app normally.
3. **Device management:** see paired browsers and unpair any browser from either Settings or the CLI.
4. **Unpaired access:** private APIs, WebSockets, logs, files, sessions, and terminal streams stay blocked.

## Scope

In scope:
- Browser auth UX for the security hardening already implemented.
- Local silent bootstrap.
- One-time browser pairing for Tailscale/LAN/remote access.
- A small Pairing panel in Settings.
- A paired-browser list for sessions created through local bootstrap or remote pairing.
- CLI pairing-code creation via `cuttlefish pair`.
- Device revocation via Settings and `cuttlefish unpair`.
- Tests and screenshots for local, remote, paired, unpaired, and error states.

Out of scope:
- User accounts.
- OAuth or direct Tailscale API integration.
- Public internet exposure.
- Putting tokens in URLs or long-term browser storage.
- Redesigning unrelated Cuttlefish navigation/pages.

## UX Contract

- Local use should feel unchanged.
- Remote use may ask for pairing once, then feel unchanged.
- WebSocket/live updates must not start until the browser is authenticated.
- The UI should say "pair this browser" or "remote access code", not "bearer token".
- The pairing screen should be calm and specific, not an error page.

## Build Phases

### Phase 1: Backend Auth UX Endpoints

Add the minimal endpoints the frontend needs:

- `GET /api/auth/state`
  - Public, non-sensitive.
  - Returns whether auth is required, whether the current request is authenticated, whether local bootstrap is available, and whether the gateway appears network-exposed.
- `POST /api/auth/bootstrap`
  - Existing loopback-only local bootstrap path stays the local zero-friction path.
- `POST /api/auth/pairing-codes`
  - Authenticated/local-only.
  - Creates a short-lived, single-use pairing code for another browser.
  - Stores only a hash or opaque verifier, not raw code in logs.
- `POST /api/auth/pair`
  - Accepts a valid one-time pairing code or admin fallback token.
  - Sets the existing HttpOnly `cuttlefish_auth` cookie.
  - Never returns the token.
- `POST /api/auth/logout`
  - Clears the browser cookie.
- `DELETE /api/auth/devices/:id`
  - Authenticated.
  - Revokes one paired browser by id.
  - Clears cookies when the revoked browser is the current browser.

Expected files:
- `packages/cuttlefish/src/gateway/auth.ts`
- `packages/cuttlefish/src/gateway/api.ts`
- `packages/cuttlefish/src/gateway/__tests__/auth-security.test.ts`

### Phase 2: Central Web Auth Controller

Add a single frontend auth controller instead of patching individual pages:

- Create `packages/web/src/lib/auth.ts`.
- Make all API calls include cookies with `credentials: "include"`.
- On a `401`, try local bootstrap once if `/api/auth/state` says it is available.
- Do not persist the gateway token or pairing code in `localStorage`.
- Keep auth state explicit: `checking`, `paired`, `pairing-required`, `pairing`, `failed`.

Expected files:
- `packages/web/src/lib/auth.ts`
- `packages/web/src/lib/api.ts`
- `packages/web/src/lib/__tests__/auth.test.ts`

### Phase 3: App-Level Auth Gate

Gate the app before private API queries and WebSockets start:

- Add an `AuthProvider`/`AuthGate`.
- Mount it above `GatewayProvider` in `packages/web/src/routes/client-providers.tsx`.
- Render normal Cuttlefish only after the browser is paired or local bootstrap succeeds.
- Render the pairing screen for remote unauthenticated browsers.
- Avoid background WebSocket reconnect loops while unauthenticated.

Expected files:
- `packages/web/src/routes/auth-provider.tsx`
- `packages/web/src/routes/client-providers.tsx`
- `packages/web/src/hooks/use-gateway.tsx` if the socket needs an auth-ready guard.

### Phase 4: Pairing Screen

Build one focused first-run remote screen:

- Shows current connection context: local, LAN, or likely Tailscale/private network.
- Separates the two pairing choices into explicit accordion-style flows:
  - `Pair with Cuttlefish CLI`: run `cuttlefish pair` on the Mac running Cuttlefish, copy the printed code, enter it remotely.
  - `Pair from Web Settings`: open an already-paired local dashboard, go to Settings > Pairing, create a code, enter it remotely.
- Accepts a one-time pairing code.
- Allows an advanced fallback token paste without making that the primary copy.
- Handles loading, bad code, expired code, and success.
- Uses Cuttlefish tokens/theme variables and works in light/dark and mobile.

Expected files:
- `packages/web/src/components/auth/pairing-screen.tsx`
- `packages/web/src/components/auth/pairing-screen.test.tsx`

### Phase 5: Pairing Settings Panel

Add a small Settings section for paired/local users:

- Shows whether auth is enabled and whether this browser is paired.
- Shows the current dashboard URL.
- Has a "Create pairing code" action.
- Shows expiry and single-use behavior.
- Shows paired browsers and marks the current browser.
- Has a "Forget this browser" action that calls logout.
- Has per-browser "Unpair" actions that call the shared device revocation endpoint.

Expected files:
- `packages/web/src/routes/settings/page.tsx`
- `packages/web/src/components/auth/remote-access-panel.tsx`
- `packages/web/src/components/auth/remote-access-panel.test.tsx`

### Phase 6: CLI Pairing And Unpairing

Add a local CLI path for users who do not want to open Settings:

- `cuttlefish pair` calls the same local gateway pairing-code endpoint as the web UI.
- It prints a one-time code and concise next steps.
- `cuttlefish unpair` lists paired browsers with their device ids.
- `cuttlefish unpair <device-id>` calls the same device revocation endpoint as the web UI.
- It never prints or stores the gateway auth token.

Expected files:
- `packages/cuttlefish/src/cli/pair.ts`
- `packages/cuttlefish/src/cli/__tests__/pair.test.ts`
- `packages/cuttlefish/bin/cuttlefish.ts`

## Definition Of Done

This work is done only when:

- Local loopback dashboard opens with no visible auth prompt.
- Remote/Tailscale dashboard shows pairing, pairs once, and survives refresh.
- Remote unpaired private APIs and WebSockets return/close unauthorized.
- Live updates and terminal WebSockets work after pairing.
- Pairing codes expire and cannot be reused.
- No token appears in URL, `localStorage`, logs, screenshots, or test output.
- Settings shows paired browsers without exposing auth secrets.
- Settings can unpair a selected browser and refresh the paired-browser list.
- `cuttlefish pair` creates a usable one-time pairing code through the same gateway API path as Settings.
- `cuttlefish unpair` lists paired browsers and revokes selected browser ids through the same gateway API path as Settings.
- Light/dark and desktop/mobile screenshots are captured.
- The verification plan passes.

## Implementation Status

Completed on 2026-06-24 and extended with guided pairing instructions, paired-browser listing, `cuttlefish pair`, split CLI/Web pairing flows, and shared web/CLI unpairing. Verification evidence is recorded in `2026-06-24-auth-ux-verification-plan.md`.
