import { useMemo, useState, type FormEvent, type ReactNode } from "react"
import { ChevronDown, KeyRound, Settings, ShieldCheck, Terminal, Wifi } from "lucide-react"
import type { AuthState } from "@/lib/auth"
import { AuthStateIcon, AuthStateLabel } from "./auth-motion"

type PairingMode = "code" | "token"
type PairingFlow = "cli" | "web" | null

interface PairingScreenProps {
  authState: Partial<AuthState> | null
  pairing: boolean
  error?: string | null
  onPair: (secret: string, mode: PairingMode) => void
}

export function PairingScreen({ authState, pairing, error, onPair }: PairingScreenProps) {
  const [code, setCode] = useState("")
  const [mode, setMode] = useState<PairingMode>("code")
  const [flow, setFlow] = useState<PairingFlow>("cli")
  const networkLabel = authState?.networkExposed ? "Private network" : "Local gateway"
  const visibleError = useMemo(() => {
    if (!error) return null
    if (/expired|invalid/i.test(error) && mode === "token") {
      return "Setup token was not accepted. Paste the current setup token or use a remote access code instead."
    }
    return /expired|invalid/i.test(error)
      ? `${error}. Create a new remote access code from a paired local dashboard and try again.`
      : error
  }, [error, mode])
  const errorId = visibleError ? "cuttlefish-pairing-error" : undefined

  function submit(e: FormEvent) {
    e.preventDefault()
    const trimmed = code.trim()
    if (!trimmed || pairing) return
    onPair(trimmed, mode)
  }

  function switchMode(nextMode: PairingMode) {
    setMode(nextMode)
    setCode("")
  }

  function toggleFlow(nextFlow: Exclude<PairingFlow, null>) {
    setFlow((current) => (current === nextFlow ? null : nextFlow))
  }

  return (
    <main className="h-dvh overflow-y-auto bg-[var(--bg)] text-[var(--text-primary)] flex items-start sm:items-center justify-center px-[var(--space-4)] py-[max(var(--safe-top),var(--space-8))]">
      <section className="w-full max-w-[560px] rounded-[var(--radius-xl)] bg-[var(--material-regular)] shadow-[var(--shadow-card)] p-[var(--space-6)]">
        <div className="mb-[var(--space-5)] flex items-center gap-[var(--space-3)] px-[var(--space-4)]">
          <div className="size-11 rounded-full bg-[var(--accent-fill)] text-[var(--accent)] flex items-center justify-center">
            <ShieldCheck size={22} />
          </div>
          <div>
            <h1 className="text-balance text-[length:var(--text-title3)] font-[var(--weight-semibold)] tracking-[var(--tracking-normal)]">
              Pair This Browser
            </h1>
            <div className="mt-1 inline-flex items-center gap-1.5 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
              <Wifi size={13} />
              {networkLabel}
            </div>
          </div>
        </div>

        <div className="mb-[var(--space-5)] rounded-[var(--radius-lg)] bg-[var(--bg-secondary)] p-[var(--space-4)]">
          <p className="text-pretty text-[length:var(--text-subheadline)] leading-[var(--leading-relaxed)] text-[var(--text-secondary)]">
            This browser is not paired yet. Choose one way to get a one-time code.
          </p>
          <div className="mt-[var(--space-3)] flex flex-col gap-2">
            <FlowButton
              active={flow === "cli"}
              icon={<Terminal size={16} />}
              title="Pair with Cuttlefish CLI"
              controls="cuttlefish-pair-cli-flow"
              onClick={() => toggleFlow("cli")}
            />
            {flow === "cli" && (
              <div id="cuttlefish-pair-cli-flow" className="animate-auth-reveal rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] px-[var(--space-3)] py-[var(--space-3)] shadow-[inset_0_0_0_1px_var(--separator)] text-[length:var(--text-footnote)] leading-[var(--leading-relaxed)] text-[var(--text-secondary)]">
                <ol className="flex flex-col gap-1.5 text-pretty">
                  <li>1. Run this on the Mac where Cuttlefish is running.</li>
                  <li>
                    2. <span className="font-[var(--font-code)] text-[var(--text-primary)]">cuttlefish pair</span>
                  </li>
                  <li>3. Copy the code it prints and enter the code below.</li>
                </ol>
              </div>
            )}

            <FlowButton
              active={flow === "web"}
              icon={<Settings size={16} />}
              title="Pair from Web Settings"
              controls="cuttlefish-pair-web-flow"
              onClick={() => toggleFlow("web")}
            />
            {flow === "web" && (
              <div id="cuttlefish-pair-web-flow" className="animate-auth-reveal rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] px-[var(--space-3)] py-[var(--space-3)] shadow-[inset_0_0_0_1px_var(--separator)] text-[length:var(--text-footnote)] leading-[var(--leading-relaxed)] text-[var(--text-secondary)]">
                <ol className="flex flex-col gap-1.5 text-pretty">
                  <li>1. Open the already-paired local dashboard on the Mac running Cuttlefish.</li>
                  <li>2. Go to Settings &gt; Pairing and press Create pairing code.</li>
                  <li>3. Bring the code back here. Enter the code below.</li>
                </ol>
              </div>
            )}
          </div>
          <p className="mt-[var(--space-3)] text-pretty text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
            The code works once and expires in a few minutes.
          </p>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-[var(--space-3)] rounded-[var(--radius-lg)] bg-[var(--bg-secondary)] p-[var(--space-4)]">
          <label className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)]" htmlFor="cuttlefish-pairing-code">
            {mode === "code" ? "Remote access code" : "Setup token"}
          </label>
          <div className="flex h-12 w-full items-center gap-2 rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] px-3 shadow-[inset_0_0_0_1px_var(--separator)] transition-[box-shadow] duration-150 [transition-timing-function:var(--ease-smooth)] focus-within:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_4px_var(--accent-fill)] sm:h-11">
            <KeyRound size={16} className="shrink-0 text-[var(--text-tertiary)]" />
            <input
              id="cuttlefish-pairing-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              type={mode === "token" ? "password" : "text"}
              autoComplete="one-time-code"
              spellCheck={false}
              aria-invalid={Boolean(visibleError)}
              aria-describedby={errorId}
              className="min-w-0 flex-1 bg-transparent text-[length:var(--text-body)] font-[var(--font-code)] tracking-[0.06em] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
              placeholder={mode === "code" ? "ABCD-EFGH-JKLM" : "Paste setup token"}
              disabled={pairing}
            />
          </div>

          <button
            type="button"
            onClick={() => switchMode(mode === "code" ? "token" : "code")}
            className="min-h-10 self-start rounded-[var(--radius-sm)] px-1 text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--accent)] transition-[transform,color,background-color] duration-150 [transition-timing-function:var(--ease-snappy)] hover:bg-[var(--accent-fill)] active:scale-[0.96]"
          >
            {mode === "code" ? "Use setup token instead" : "Use remote access code"}
          </button>

          {visibleError && (
            <div id={errorId} role="alert" aria-live="polite" className="animate-auth-reveal rounded-[var(--radius-md)] bg-[color-mix(in_srgb,var(--system-red)_12%,transparent)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-footnote)] text-[var(--system-red)]">
              {visibleError}
            </div>
          )}

          <button
            type="submit"
            disabled={pairing || code.trim().length === 0}
            aria-label={pairing ? "Pairing browser" : "Pair Browser"}
            className="mt-[var(--space-2)] inline-flex h-11 items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--accent)] px-[var(--space-4)] text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--accent-contrast)] transition-[transform,filter,opacity] duration-150 [transition-timing-function:var(--ease-snappy)] hover:brightness-[1.04] active:scale-[0.96] disabled:opacity-55 disabled:hover:brightness-100 disabled:active:scale-100"
          >
            <AuthStateIcon busy={pairing} idleIcon={KeyRound} size={16} />
            <AuthStateLabel busy={pairing} idle="Pair Browser" busyText="Pairing..." className="min-w-[6.75rem]" />
          </button>
        </form>
      </section>
    </main>
  )
}

function FlowButton({
  active,
  icon,
  title,
  controls,
  onClick,
}: {
  active: boolean
  icon: ReactNode
  title: string
  controls: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={active}
      aria-controls={controls}
      className="flex min-h-11 w-full items-center gap-[var(--space-3)] rounded-[var(--radius-md)] bg-[var(--material-thin)] px-[var(--space-3)] text-left text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)] shadow-[inset_0_0_0_1px_var(--separator)] transition-[transform,background-color,box-shadow] duration-150 [transition-timing-function:var(--ease-snappy)] hover:bg-[var(--fill-secondary)] hover:shadow-[inset_0_0_0_1px_var(--separator),var(--shadow-subtle)] active:scale-[0.96]"
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent-fill)] text-[var(--accent)]">
        {icon}
      </span>
      <span className="min-w-0 flex-1">{title}</span>
      <ChevronDown
        size={15}
        className={`shrink-0 text-[var(--text-tertiary)] transition-transform ${active ? "rotate-180" : ""}`}
      />
    </button>
  )
}
