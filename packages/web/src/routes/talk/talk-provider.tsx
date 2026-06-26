/**
 * Cuttlefish Talk — state provider lifted ABOVE the router.
 *
 * `useTalk()` is called once here, mounted outside <Routes> (in
 * client-providers.tsx), so the WS subscription, audio player, transcript,
 * threads and cards stay alive across `/` ↔ `/talk` navigation instead of being
 * destroyed when TalkPage unmounts. TalkPage consumes this via useTalkContext().
 *
 * The hook's heavy bootstrap (creating the orchestrator session, probing TTS,
 * rehydrating) is gated behind `activate()` — which TalkPage calls on mount — so
 * the provider being globally mounted does NOT spin up a talk session for users
 * who never open /talk.
 */
import { createContext, useContext, type ReactNode } from "react"
import { useTalk, type UseTalkReturn } from "./use-talk"

const TalkContext = createContext<UseTalkReturn | null>(null)

export function TalkProvider({ children }: { children: ReactNode }) {
  const talk = useTalk()
  return <TalkContext.Provider value={talk}>{children}</TalkContext.Provider>
}

export function useTalkContext(): UseTalkReturn {
  const ctx = useContext(TalkContext)
  if (!ctx) throw new Error("useTalkContext must be used within <TalkProvider>")
  return ctx
}
