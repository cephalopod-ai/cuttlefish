import { useState } from "react"
import { Copy, KeyRound, Laptop, LogOut, ShieldCheck, Smartphone, Unlink } from "lucide-react"
import type { AuthState, PairedDevice, PairingCode } from "@/lib/auth"
import { AuthStateIcon, AuthStateLabel } from "./auth-motion"

interface RemoteAccessPanelProps {
  authState: Partial<AuthState> | null
  devices?: PairedDevice[]
  onCreatePairingCode: () => Promise<PairingCode>
  onLogout: () => void | Promise<void>
  onUnpairDevice?: (deviceId: string) => void | Promise<void>
}

export function RemoteAccessPanel({ authState, devices = [], onCreatePairingCode, onLogout, onUnpairDevice }: RemoteAccessPanelProps) {
  const [pairingCode, setPairingCode] = useState<PairingCode | null>(null)
  const [creating, setCreating] = useState(false)
  const [forgetting, setForgetting] = useState(false)
  const [unpairingId, setUnpairingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const dashboardUrl = typeof window !== "undefined" ? window.location.origin : ""
  const canCreatePairingCode = Boolean(authState?.authRequired && authState.authenticated && authState.canBootstrapLocal)

  async function createCode() {
    if (!canCreatePairingCode) return
    setCreating(true)
    setError(null)
    try {
      setPairingCode(await onCreatePairingCode())
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create pairing code")
    } finally {
      setCreating(false)
    }
  }

  async function forgetBrowser() {
    setForgetting(true)
    setError(null)
    try {
      await onLogout()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to forget this browser")
    } finally {
      setForgetting(false)
    }
  }

  async function unpairDevice(device: PairedDevice) {
    if (!onUnpairDevice || unpairingId) return
    setUnpairingId(device.id)
    setError(null)
    try {
      await onUnpairDevice(device.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to unpair ${device.name}`)
    } finally {
      setUnpairingId(null)
    }
  }

  return (
    <div className="flex flex-col gap-[var(--space-4)]">
      <div className="flex items-start gap-[var(--space-3)]">
        <div className="mt-0.5 size-8 rounded-full bg-[var(--accent-fill)] text-[var(--accent)] flex items-center justify-center">
          <ShieldCheck size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
            {authState?.authenticated ? "This browser is paired" : "This browser is not paired"}
          </div>
          <div className="mt-1 text-pretty text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
            {authState?.networkExposed ? "New Tailscale or LAN browsers need a one-time code." : "Local access stays automatic on this Mac."}
          </div>
        </div>
      </div>

      {dashboardUrl && (
        <div className="rounded-[var(--radius-md)] bg-[var(--bg-secondary)] px-[var(--space-3)] py-[var(--space-2)] shadow-[inset_0_0_0_1px_var(--separator)]">
          <div className="text-[length:var(--text-caption2)] uppercase text-[var(--text-quaternary)]">Dashboard URL</div>
          <div className="mt-1 truncate font-[var(--font-code)] text-[length:var(--text-footnote)] text-[var(--text-secondary)]">{dashboardUrl}</div>
        </div>
      )}

      <div className="flex flex-wrap gap-[var(--space-2)]">
        <button
          type="button"
          onClick={createCode}
          disabled={creating || !canCreatePairingCode}
          aria-label={creating ? "Creating pairing code" : "Create pairing code"}
          className="inline-flex h-10 items-center gap-2 rounded-[var(--radius-md)] bg-[var(--accent)] pl-[var(--space-3)] pr-[calc(var(--space-3)_-_2px)] text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--accent-contrast)] transition-[transform,filter,opacity] duration-150 [transition-timing-function:var(--ease-snappy)] hover:brightness-[1.04] active:scale-[0.96] disabled:opacity-60 disabled:hover:brightness-100 disabled:active:scale-100"
        >
          <AuthStateIcon busy={creating} idleIcon={KeyRound} size={14} />
          <AuthStateLabel busy={creating} idle="Create pairing code" busyText="Creating..." className="min-w-[8.5rem] justify-items-start" />
        </button>
        <button
          type="button"
          onClick={() => { void forgetBrowser() }}
          disabled={forgetting}
          aria-label={forgetting ? "Forgetting this browser" : "Forget this browser"}
          className="inline-flex h-10 items-center gap-2 rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] pl-[var(--space-3)] pr-[calc(var(--space-3)_-_2px)] text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-secondary)] transition-[transform,background-color,opacity] duration-150 [transition-timing-function:var(--ease-snappy)] hover:bg-[var(--fill-secondary)] active:scale-[0.96] disabled:opacity-60 disabled:active:scale-100"
        >
          <AuthStateIcon busy={forgetting} idleIcon={LogOut} size={14} />
          <AuthStateLabel busy={forgetting} idle="Forget this browser" busyText="Forgetting..." className="min-w-[8rem] justify-items-start" />
        </button>
      </div>

      {!canCreatePairingCode && (
        <div className="text-pretty text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          Create codes from the local Mac dashboard.
        </div>
      )}

      {pairingCode && (
        <div key={pairingCode.code} role="status" aria-live="polite" className="animate-auth-reveal rounded-[var(--radius-lg)] bg-[var(--bg-secondary)] p-[var(--space-4)] shadow-[inset_0_0_0_1px_var(--separator)]">
          <div className="flex items-center justify-between gap-[var(--space-3)]">
            <div className="min-w-0 truncate font-[var(--font-code)] text-[length:var(--text-body)] font-[var(--weight-semibold)] tracking-[0.08em] text-[var(--text-primary)]">
              {pairingCode.code}
            </div>
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(pairingCode.code).catch(() => {})}
              className="inline-flex size-10 items-center justify-center rounded-full text-[var(--text-secondary)] transition-[transform,background-color,color] duration-150 [transition-timing-function:var(--ease-snappy)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] active:scale-[0.96]"
              aria-label="Copy pairing code"
            >
              <Copy size={14} />
            </button>
          </div>
          <div className="mt-2 text-pretty text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
            On the other device, open Cuttlefish and enter this code. It is single-use and expires at {new Date(pairingCode.expiresAt).toLocaleTimeString()}.
          </div>
        </div>
      )}

      <div className="pt-[var(--space-2)]">
        <div className="mb-[var(--space-2)] text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)]">
          Paired browsers
        </div>
        <div className="flex flex-col gap-2">
          {devices.length === 0 ? (
            <div className="rounded-[var(--radius-md)] bg-[var(--bg-secondary)] px-[var(--space-3)] py-[var(--space-3)] shadow-[inset_0_0_0_1px_var(--separator)] text-pretty text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
              Paired browsers will appear here after local bootstrap or remote pairing.
            </div>
          ) : devices.map((device) => (
            <div
              key={device.id}
              className="flex items-center gap-[var(--space-3)] rounded-[var(--radius-md)] bg-[var(--bg-secondary)] px-[var(--space-3)] py-[var(--space-3)] shadow-[inset_0_0_0_1px_var(--separator)] transition-[background-color,box-shadow] duration-150 [transition-timing-function:var(--ease-smooth)] hover:bg-[var(--fill-tertiary)] hover:shadow-[inset_0_0_0_1px_var(--separator),var(--shadow-subtle)]"
            >
              <div className="size-8 shrink-0 rounded-full bg-[var(--fill-tertiary)] text-[var(--text-secondary)] flex items-center justify-center">
                {isMobileDevice(device) ? <Smartphone size={15} /> : <Laptop size={15} />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="truncate text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
                    {device.name}
                  </div>
                  {device.current && (
                    <span className="rounded-full bg-[var(--accent-fill)] px-2 py-0.5 text-[length:var(--text-caption2)] font-[var(--weight-semibold)] text-[var(--accent)]">
                      Current
                    </span>
                  )}
                </div>
                <div className="mt-0.5 truncate text-[length:var(--text-caption1)] tabular-nums text-[var(--text-tertiary)]">
                  {deviceMeta(device)}
                </div>
              </div>
              {onUnpairDevice && !device.current && (
                <button
                  type="button"
                  onClick={() => { void unpairDevice(device) }}
                  disabled={Boolean(unpairingId)}
                  className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--fill-tertiary)] pl-2.5 pr-2 text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)] transition-[transform,background-color,opacity] duration-150 [transition-timing-function:var(--ease-snappy)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] active:scale-[0.96] disabled:opacity-50 disabled:active:scale-100"
                  aria-label={unpairingId === device.id ? `Unpairing ${device.name}` : `Unpair ${device.name}`}
                >
                  <AuthStateIcon busy={unpairingId === device.id} idleIcon={Unlink} size={13} />
                  <AuthStateLabel busy={unpairingId === device.id} idle="Unpair" busyText="..." className="min-w-[2.6rem] justify-items-start" />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {error && (
        <div className="text-[length:var(--text-footnote)] text-[var(--system-red)]">
          {error}
        </div>
      )}
    </div>
  )
}

function isMobileDevice(device: PairedDevice): boolean {
  return /iphone|ipad|android|mobile/i.test(`${device.name} ${device.userAgent || ""}`)
}

function formatWhen(value: string): string {
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return "recently"
  const delta = Date.now() - timestamp
  if (delta < 60_000) return "just now"
  if (delta < 3_600_000) return `${Math.max(1, Math.floor(delta / 60_000))} min ago`
  if (delta < 86_400_000) return `${Math.max(1, Math.floor(delta / 3_600_000))} hr ago`
  return new Date(value).toLocaleDateString()
}

function deviceMeta(device: PairedDevice): string {
  const parts = [
    device.lastSeenAt ? `Last seen ${formatWhen(device.lastSeenAt)}` : "Paired browser",
    device.kind ? kindLabel(device.kind) : null,
    device.lastIp || null,
  ].filter(Boolean)
  return parts.join(" · ")
}

function kindLabel(kind: NonNullable<PairedDevice["kind"]>): string {
  if (kind === "local") return "Local"
  if (kind === "token") return "Setup token"
  return "Remote"
}
