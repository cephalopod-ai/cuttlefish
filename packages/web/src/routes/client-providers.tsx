
import type { ReactNode } from "react"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from '@/lib/query-client'
import { ThemeProvider } from "@/routes/providers"
import { SettingsProvider, DocumentTitle } from "@/routes/settings-provider"
import { useQueryInvalidation } from '@/hooks/use-query-invalidation'
import { BreadcrumbProvider } from '@/context/breadcrumb-context'
import { EmojiFavicon } from '@/components/emoji-favicon'
import { GatewayProvider } from '@/hooks/use-gateway'
import { TalkProvider } from '@/routes/talk/talk-provider'
import { AuthGate, AuthProvider } from "@/routes/auth-provider"

function QueryInvalidationBridge() {
  useQueryInvalidation()
  return null
}

export function ClientProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <BreadcrumbProvider>
          <AuthProvider>
            <AuthGate>
              <SettingsProvider>
                <GatewayProvider>
                  {/* TalkProvider lifts the voice-loop state above the router so it
                      survives / ↔ /talk navigation. It stays dormant until a page
                      calls activate() (TalkPage does, on mount). */}
                  <TalkProvider>
                    {children}
                    <DocumentTitle />
                    <EmojiFavicon />
                    <QueryInvalidationBridge />
                  </TalkProvider>
                </GatewayProvider>
              </SettingsProvider>
            </AuthGate>
          </AuthProvider>
        </BreadcrumbProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
