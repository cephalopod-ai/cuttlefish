export interface AuthState {
  authRequired: boolean
  authenticated: boolean
  canBootstrapLocal: boolean
  networkExposed: boolean
}

export interface PairingCode {
  code: string
  expiresAt: string
  ttlSeconds?: number
}

export interface PairedDevice {
  id: string
  name: string
  kind?: "local" | "remote" | "token"
  createdAt?: string
  lastSeenAt?: string
  lastIp?: string
  userAgent?: string
  current?: boolean
}

const BASE =
  typeof window !== "undefined" && window.location.origin !== "null"
    ? window.location.origin
    : "http://localhost:3000"

let launchBootstrapToken: string | null = null
let launchBootstrapPromise: Promise<void> | null = null

function browserBootstrapToken(): string | null {
  if (launchBootstrapToken) return launchBootstrapToken
  if (typeof window === "undefined") return launchBootstrapToken
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""))
  const token = params.get("bootstrap")
  if (!token) return launchBootstrapToken
  launchBootstrapToken = token
  params.delete("bootstrap")
  const hash = params.toString()
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${hash ? `#${hash}` : ""}`)
  return launchBootstrapToken
}

export function hasBrowserBootstrapCapability(): boolean {
  return Boolean(launchBootstrapPromise || browserBootstrapToken())
}

function urlFor(path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  return `${BASE}${path.startsWith("/") ? path : `/${path}`}`
}

function withCredentials(init: RequestInit = {}): RequestInit {
  return { ...init, credentials: "include" }
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `API error: ${res.status}`
    try {
      const body = await res.json()
      if (body?.error) message = String(body.error)
      else if (body?.message) message = String(body.message)
    } catch {
      /* keep fallback */
    }
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

export async function getAuthState(): Promise<AuthState> {
  const res = await fetch(urlFor("/api/auth/state"), withCredentials({ method: "GET" }))
  return jsonOrThrow<AuthState>(res)
}

export async function bootstrapLocalAuth(): Promise<void> {
  if (launchBootstrapPromise) return launchBootstrapPromise
  const token = browserBootstrapToken()
  if (!token) throw new Error("Open the dashboard from `cuttlefish start` or pair this browser")
  // Consume the browser-held capability before the request. Concurrent React
  // effects share one request, and a rejected/expired token is never replayed.
  launchBootstrapToken = null
  launchBootstrapPromise = (async () => {
    const res = await fetch(urlFor("/api/auth/bootstrap"), withCredentials({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }))
    await jsonOrThrow(res)
  })()
  try {
    await launchBootstrapPromise
  } finally {
    launchBootstrapPromise = null
  }
}

export async function pairBrowser(secret: string, mode: "code" | "token" = "code"): Promise<void> {
  const res = await fetch(
    urlFor("/api/auth/pair"),
    withCredentials({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mode === "token" ? { token: secret } : { code: secret }),
    }),
  )
  await jsonOrThrow(res)
}

export async function createPairingCode(): Promise<PairingCode> {
  const res = await fetch(
    urlFor("/api/auth/pairing-codes"),
    withCredentials({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),
  )
  return jsonOrThrow<PairingCode>(res)
}

export async function listPairedDevices(): Promise<PairedDevice[]> {
  const res = await fetch(urlFor("/api/auth/devices"), withCredentials({ method: "GET" }))
  const body = await jsonOrThrow<{ devices: PairedDevice[] }>(res)
  return body.devices
}

export async function unpairDevice(deviceId: string): Promise<void> {
  const res = await fetch(
    urlFor(`/api/auth/devices/${encodeURIComponent(deviceId)}`),
    withCredentials({ method: "DELETE" }),
  )
  await jsonOrThrow(res)
}

export async function logoutBrowser(): Promise<void> {
  const res = await fetch(urlFor("/api/auth/logout"), withCredentials({ method: "POST", body: "{}" }))
  await jsonOrThrow(res)
}

export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const url = urlFor(input)
  const first = await fetch(url, withCredentials(init))
  if (first.status !== 401) return first

  let state: AuthState
  try {
    state = await getAuthState()
  } catch {
    return first
  }
  // A loopback gateway can allow ordinary reads without globally requiring
  // auth while still protecting approval decisions as operator-only actions.
  // Bootstrap on that 401 whenever this is a local browser with no real
  // credential; `authRequired` describes the global gate, not whether this
  // particular endpoint needs an operator principal.
  if (state.authenticated || !state.canBootstrapLocal) return first

  try {
    await bootstrapLocalAuth()
  } catch {
    return first
  }
  return fetch(url, withCredentials(init))
}
