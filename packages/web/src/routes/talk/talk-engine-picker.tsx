/**
 * Cuttlefish Talk — orchestrator engine/model picker.
 *
 * A tiny gear button in the top bar opens a quiet popover to pick the voice
 * orchestrator's ENGINE (from the resolved available set) and MODEL (from the
 * live registry). Engine is new-chat-only — the hook re-bootstraps the talk
 * session on change; model applies on the next turn. When no engine is
 * installed the popover shows an actionable message instead of an empty list.
 */
import { Settings2 } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { useModelRegistry } from "@/hooks/use-model-registry"
import type { TalkEngineInfo } from "./use-talk"

const engineLabel = (e: string) => e.charAt(0).toUpperCase() + e.slice(1)

interface TalkEnginePickerProps {
  engineInfo: TalkEngineInfo
  onSwitchEngine: (engine: string) => void
  onSwitchModel: (model: string) => void
}

export function TalkEnginePicker({ engineInfo, onSwitchEngine, onSwitchModel }: TalkEnginePickerProps) {
  const { data: registry } = useModelRegistry()
  const { engine, model, fallback, reason, available } = engineInfo

  const entry = engine ? registry?.engines?.[engine] : undefined
  const models = entry?.models ?? []
  const noEngine = available.length === 0

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label="Voice engine settings"
          className="relative inline-flex size-9 items-center justify-center rounded-full border border-[var(--separator)] bg-[var(--material-regular)] text-[var(--text-secondary)] backdrop-blur-md transition-colors active:bg-[var(--fill-secondary)]"
        >
          <Settings2 size={16} />
          {/* Subtle dot when the engine fell back from the configured one. */}
          {fallback && (
            <span
              aria-hidden
              className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-[var(--system-orange)]"
            />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[210px] max-w-[260px]">
        <DropdownMenuLabel>Voice engine</DropdownMenuLabel>
        {noEngine ? (
          <div className="px-2 py-1.5 text-[length:var(--text-caption1)] leading-snug text-[var(--text-secondary)]">
            No engine is installed for the voice orchestrator. Install a CLI
            (claude, codex, …) or set <span className="font-[family-name:var(--font-code)]">engines.&lt;name&gt;.bin</span> in
            config.yaml, then reopen Talk.
          </div>
        ) : (
          <DropdownMenuRadioGroup value={engine ?? ""} onValueChange={onSwitchEngine}>
            {available.map((e) => (
              <DropdownMenuRadioItem key={e} value={e}>
                {engineLabel(e)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        )}

        {fallback && engine && (
          <div className="px-2 py-1 text-[length:var(--text-caption2)] leading-snug text-[var(--system-orange)]">
            {reason || `Configured engine unavailable — using ${engineLabel(engine)}.`}
          </div>
        )}

        {models.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Model</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={model ?? ""} onValueChange={onSwitchModel}>
              {models.map((m) => (
                <DropdownMenuRadioItem key={m.id} value={m.id}>
                  {m.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
