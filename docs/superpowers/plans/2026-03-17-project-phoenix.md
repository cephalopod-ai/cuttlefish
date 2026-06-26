# Project Phoenix Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modernize the Cuttlefish web dashboard with shadcn/ui, TanStack Query, chat multitasking (tabs + split view), command palette, goal hierarchy, working cost tracking, and CI pipeline.

**Architecture:** 5 sequential phases where each produces a shippable state. Phase 1 (foundation) enables all others. Phases 2 and 3 can be parallelized after Phase 1. Frontend is Next.js 15 static export with React 19. Backend is Node.js gateway with SQLite. All new features are client-side only (no SSR).

**Tech Stack:** React 19, Next.js 15, Tailwind CSS v4, shadcn/ui (New York), TanStack React Query v5, cmdk v1, Vitest v3, Playwright, GitHub Actions

**Spec:** `docs/superpowers/specs/2026-03-17-project-phoenix-design.md`

---

## File Structure

### Phase 1 - New files
| File | Responsibility |
|------|---------------|
| `packages/web/src/lib/query-client.ts` | QueryClient singleton with default options |
| `packages/web/src/lib/query-keys.ts` | Query key factory for all API resources |
| `packages/web/src/hooks/use-sessions.ts` | React Query hooks for sessions API |
| `packages/web/src/hooks/use-employees.ts` | React Query hooks for org/employees API |
| `packages/web/src/hooks/use-cron.ts` | React Query hooks for cron API |
| `packages/web/src/hooks/use-skills.ts` | React Query hooks for skills API |
| `packages/web/src/hooks/use-config.ts` | React Query hooks for config/status API |
| `packages/web/src/hooks/use-query-invalidation.ts` | WS event → React Query cache invalidation bridge |

### Phase 2 - New files
| File | Responsibility |
|------|---------------|
| `packages/web/src/components/chat/chat-tabs.tsx` | Tab bar component with state persistence |
| `packages/web/src/components/chat/chat-pane.tsx` | Single chat pane (extracted from page.tsx) |
| `packages/web/src/components/chat/chat-split.tsx` | Split view container (1/2/3 panes) |
| `packages/web/src/hooks/use-chat-tabs.ts` | Tab state management (open/close/switch/persist) |

### Phase 3 - New files
| File | Responsibility |
|------|---------------|
| `packages/web/src/context/breadcrumb-context.tsx` | Breadcrumb provider + useBreadcrumbs hook |
| `packages/web/src/components/breadcrumb-bar.tsx` | Breadcrumb display (single = title, multi = trail) |

### Phase 4 - New files
| File | Responsibility |
|------|---------------|
| `packages/cuttlefish/src/gateway/costs.ts` | Cost aggregation API routes |
| `packages/cuttlefish/src/gateway/budgets.ts` | Budget CRUD + enforcement API routes |
| `packages/cuttlefish/src/gateway/goals.ts` | Goals CRUD API routes |
| `packages/web/src/hooks/use-costs.ts` | React Query hooks for costs/budgets API |
| `packages/web/src/hooks/use-goals.ts` | React Query hooks for goals API |
| `packages/web/src/app/goals/page.tsx` | Goals tree page |

### Phase 5 - New files
| File | Responsibility |
|------|---------------|
| `packages/cuttlefish/vitest.config.ts` | Backend vitest config (ESM, in-memory SQLite) |
| `packages/web/vitest.config.ts` | Frontend vitest config (jsdom, React testing library) |
| `packages/cuttlefish/src/engines/mock.ts` | Mock engine for E2E (canned responses + streaming sim) |
| `playwright.config.ts` | Playwright config (base URL, global setup) |
| `e2e/global-setup.ts` | Start test gateway with mock engine |
| `e2e/smoke.spec.ts` | Dashboard loads, nav links, no console errors |
| `e2e/chat.spec.ts` | Send message, streaming, sidebar update |
| `.github/workflows/ci.yml` | Typecheck + unit tests + build + E2E |

---

## Phase 1: Foundation

### Task 1: Install missing shadcn/ui components

**Files:**
- Modify: `packages/web/package.json`
- Create: `packages/web/src/components/ui/dropdown-menu.tsx`
- Create: `packages/web/src/components/ui/popover.tsx`
- Create: `packages/web/src/components/ui/select.tsx`
- Create: `packages/web/src/components/ui/input.tsx`
- Create: `packages/web/src/components/ui/textarea.tsx`
- Create: `packages/web/src/components/ui/sheet.tsx`
- Create: `packages/web/src/components/ui/context-menu.tsx`
- Create: `packages/web/src/components/ui/toggle.tsx`
- Create: `packages/web/src/components/ui/toggle-group.tsx`
- Create: `packages/web/src/components/ui/alert.tsx`
- Create: `packages/web/src/components/ui/alert-dialog.tsx`
- Create: `packages/web/src/components/ui/command.tsx`
- Create: `packages/web/src/components/ui/breadcrumb.tsx`

- [ ] **Step 1: Install shadcn components via CLI**

```bash
cd ~/Projects/cuttlefish/packages/web
npx shadcn@latest add dropdown-menu popover select input textarea sheet context-menu toggle toggle-group alert alert-dialog command breadcrumb
```

This installs all missing components + their Radix dependencies. The CLI reads `components.json` (already configured with New York style) and generates files in `src/components/ui/`.

- [ ] **Step 2: Verify components were created**

```bash
ls -la src/components/ui/
```

Expected: All 9 existing components + 14 new ones listed.

- [ ] **Step 3: Verify build passes**

```bash
cd ~/Projects/cuttlefish && pnpm build
```

Expected: Clean build. If shadcn generates Tailwind v3 syntax (e.g., `dark:` classes without the custom variant), we'll fix in Task 2.

- [ ] **Step 4: Commit**

```bash
cd ~/Projects/cuttlefish
git add packages/web/src/components/ui/ packages/web/package.json pnpm-lock.yaml
git commit -m "feat(web): install missing shadcn/ui components (dropdown, popover, select, input, sheet, command, etc.)"
```

---

### Task 2: Reconcile theme system with shadcn dark mode

**Files:**
- Modify: `packages/web/src/app/globals.css`

The issue: shadcn components use Tailwind's `dark:` variant which expects `.dark` class on `<html>`. Our system uses `data-theme` attribute. We need to override Tailwind v4's dark variant selector.

- [ ] **Step 1: Add custom dark variant to globals.css**

At the top of `packages/web/src/app/globals.css`, after the `@import` lines and before the `@theme` block, add:

```css
/* :where() has zero specificity so shadcn's dark: utilities remain overridable.
   data-theme is never "system" after JS hydration - ThemeProvider resolves it to dark/light. */
@custom-variant dark (&:where([data-theme="dark"], [data-theme="glass"], [data-theme="color"]) *);
```

This tells Tailwind v4 that `dark:` classes should apply when any of the three dark-background themes are active.

- [ ] **Step 2: Verify shadcn components render in all themes**

```bash
cd ~/Projects/cuttlefish && pnpm build
```

Expected: Clean build. The `dark:` prefixed classes in shadcn components will now correctly activate for dark/glass/color themes.

- [ ] **Step 3: Manual verification**

Start the gateway (`cuttlefish start`), open the dashboard, switch between all 5 themes (dark, glass, color, light, system). Verify that shadcn components (buttons, cards, dialogs) look correct in each theme. Pay special attention to:
- Button backgrounds (should be visible in light theme)
- Card borders (should be visible in dark theme)
- Dialog overlay opacity

- [ ] **Step 4: Commit**

```bash
cd ~/Projects/cuttlefish
git add packages/web/src/app/globals.css
git commit -m "fix(web): reconcile shadcn dark: variant with data-theme attribute system"
```

---

### Task 3: Install TanStack React Query + create QueryClient

**Files:**
- Modify: `packages/web/package.json`
- Create: `packages/web/src/lib/query-client.ts`
- Modify: `packages/web/src/app/client-providers.tsx`

- [ ] **Step 1: Install @tanstack/react-query**

```bash
cd ~/Projects/cuttlefish/packages/web
pnpm add @tanstack/react-query@^5
```

- [ ] **Step 2: Create query client singleton**

Create `packages/web/src/lib/query-client.ts`:

```typescript
import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
})
```

- [ ] **Step 3: Add QueryClientProvider to client-providers.tsx**

In `packages/web/src/app/client-providers.tsx`, wrap the existing provider tree with `QueryClientProvider`:

```typescript
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from '@/lib/query-client'
```

Wrap the outermost provider:
```tsx
<QueryClientProvider client={queryClient}>
  <ThemeProvider>
    <SettingsProvider>
      <NotificationProvider>
        <DocumentTitle />
        {children}
      </NotificationProvider>
    </SettingsProvider>
  </ThemeProvider>
</QueryClientProvider>
```

- [ ] **Step 4: Verify build**

```bash
cd ~/Projects/cuttlefish && pnpm build
```

Expected: Clean build. React Query is now available to all components via the provider.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/cuttlefish
git add packages/web/src/lib/query-client.ts packages/web/src/app/client-providers.tsx packages/web/package.json pnpm-lock.yaml
git commit -m "feat(web): add TanStack React Query v5 with QueryClientProvider"
```

---

### Task 4: Create query key factory

**Files:**
- Create: `packages/web/src/lib/query-keys.ts`

- [ ] **Step 1: Create the query key factory**

Create `packages/web/src/lib/query-keys.ts`:

```typescript
export const queryKeys = {
  sessions: {
    all: ['sessions'] as const,
    detail: (id: string) => ['sessions', id] as const,
    children: (id: string) => ['sessions', id, 'children'] as const,
    transcript: (id: string) => ['sessions', id, 'transcript'] as const,
    queue: (id: string) => ['sessions', id, 'queue'] as const,
  },
  org: {
    all: ['org'] as const,
    employee: (name: string) => ['org', 'employees', name] as const,
    board: (dept: string) => ['org', 'departments', dept, 'board'] as const,
  },
  cron: {
    all: ['cron'] as const,
    runs: (id: string) => ['cron', id, 'runs'] as const,
  },
  costs: {
    summary: (period: string) => ['costs', 'summary', period] as const,
    byEmployee: (period: string) => ['costs', 'by-employee', period] as const,
  },
  budgets: {
    all: ['budgets'] as const,
  },
  goals: {
    all: ['goals'] as const,
    tree: ['goals', 'tree'] as const,
    detail: (id: string) => ['goals', id] as const,
    tasks: (id: string) => ['goals', id, 'tasks'] as const,
  },
  skills: {
    all: ['skills'] as const,
    detail: (name: string) => ['skills', name] as const,
  },
  config: ['config'] as const,
  status: ['status'] as const,
  onboarding: ['onboarding'] as const,
} as const
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd ~/Projects/cuttlefish && pnpm typecheck
```

- [ ] **Step 3: Commit**

```bash
cd ~/Projects/cuttlefish
git add packages/web/src/lib/query-keys.ts
git commit -m "feat(web): add React Query key factory for all API resources"
```

---

### Task 5: Create core query hooks (sessions, org, cron, skills, config)

**Files:**
- Create: `packages/web/src/hooks/use-sessions.ts`
- Create: `packages/web/src/hooks/use-employees.ts`
- Create: `packages/web/src/hooks/use-cron.ts`
- Create: `packages/web/src/hooks/use-skills.ts`
- Create: `packages/web/src/hooks/use-config.ts`

- [ ] **Step 1: Create sessions hooks**

Create `packages/web/src/hooks/use-sessions.ts`:

**Important**: `lib/api.ts` exports a single `api` object (NOT named function exports). All hooks must import `api` and call `api.methodName()`.

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { api } from '@/lib/api'

export function useSessions() {
  return useQuery({
    queryKey: queryKeys.sessions.all,
    queryFn: () => api.getSessions(),
  })
}

export function useSession(id: string | null) {
  return useQuery({
    queryKey: queryKeys.sessions.detail(id!),
    queryFn: () => api.getSession(id!),
    enabled: !!id,
  })
}

export function useSessionChildren(id: string | null) {
  return useQuery({
    queryKey: queryKeys.sessions.children(id!),
    queryFn: () => api.getSessionChildren(id!),
    enabled: !!id,
  })
}

export function useSessionTranscript(id: string | null) {
  return useQuery({
    queryKey: queryKeys.sessions.transcript(id!),
    queryFn: () => api.getSessionTranscript(id!),
    enabled: !!id,
  })
}

export function useSessionQueue(id: string | null) {
  return useQuery({
    queryKey: queryKeys.sessions.queue(id!),
    queryFn: () => api.getSessionQueue(id!),
    enabled: !!id,
    refetchInterval: 5_000,
  })
}

export function useDeleteSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.sessions.all }),
  })
}

export function useBulkDeleteSessions() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids: string[]) => api.bulkDeleteSessions(ids),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.sessions.all }),
  })
}

export function useCreateSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: Parameters<typeof api.createSession>[0]) => api.createSession(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.sessions.all }),
  })
}

export function useSendMessage() {
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof api.sendMessage>[1] }) =>
      api.sendMessage(id, data),
  })
}

export function useStopSession() {
  return useMutation({
    mutationFn: (id: string) => api.stopSession(id),
  })
}
```

- [ ] **Step 2: Create employees hook**

Create `packages/web/src/hooks/use-employees.ts`:

```typescript
import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { api } from '@/lib/api'

export function useOrg() {
  return useQuery({
    queryKey: queryKeys.org.all,
    queryFn: () => api.getOrg(),
  })
}

export function useEmployee(name: string | null) {
  return useQuery({
    queryKey: queryKeys.org.employee(name!),
    queryFn: () => api.getEmployee(name!),
    enabled: !!name,
  })
}

export function useDepartmentBoard(dept: string | null) {
  return useQuery({
    queryKey: queryKeys.org.board(dept!),
    queryFn: () => api.getDepartmentBoard(dept!),
    enabled: !!dept,
  })
}
```

- [ ] **Step 3: Create cron hook**

Create `packages/web/src/hooks/use-cron.ts`:

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { api } from '@/lib/api'

export function useCronJobs() {
  return useQuery({
    queryKey: queryKeys.cron.all,
    queryFn: () => api.getCronJobs(),
  })
}

export function useCronRuns(id: string | null) {
  return useQuery({
    queryKey: queryKeys.cron.runs(id!),
    queryFn: () => api.getCronRuns(id!),
    enabled: !!id,
  })
}

export function useUpdateCronJob() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof api.updateCronJob>[1] }) =>
      api.updateCronJob(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.cron.all }),
  })
}

export function useTriggerCronJob() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.triggerCronJob(id),
    onSuccess: (_, id) => qc.invalidateQueries({ queryKey: queryKeys.cron.runs(id) }),
  })
}
```

- [ ] **Step 4: Create skills hook**

Create `packages/web/src/hooks/use-skills.ts`:

```typescript
import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { api } from '@/lib/api'

export function useSkills() {
  return useQuery({
    queryKey: queryKeys.skills.all,
    queryFn: () => api.getSkills(),
  })
}

export function useSkill(name: string | null) {
  return useQuery({
    queryKey: queryKeys.skills.detail(name!),
    queryFn: () => api.getSkill(name!),
    enabled: !!name,
  })
}
```

- [ ] **Step 5: Create config/status hooks**

Create `packages/web/src/hooks/use-config.ts`:

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { api } from '@/lib/api'

export function useConfig() {
  return useQuery({
    queryKey: queryKeys.config,
    queryFn: () => api.getConfig(),
  })
}

export function useUpdateConfig() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: unknown) => api.updateConfig(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.config }),
  })
}

export function useStatus() {
  return useQuery({
    queryKey: queryKeys.status,
    queryFn: () => api.getStatus(),
    refetchInterval: 30_000,
  })
}
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
cd ~/Projects/cuttlefish && pnpm typecheck
```

Expected: PASS. All hooks reference existing API functions from `lib/api.ts`.

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/cuttlefish
git add packages/web/src/hooks/use-sessions.ts packages/web/src/hooks/use-employees.ts packages/web/src/hooks/use-cron.ts packages/web/src/hooks/use-skills.ts packages/web/src/hooks/use-config.ts
git commit -m "feat(web): add React Query hooks for sessions, org, cron, skills, config"
```

---

### Task 6: Create WebSocket → React Query invalidation bridge

**Files:**
- Create: `packages/web/src/hooks/use-query-invalidation.ts`
- Modify: `packages/web/src/app/client-providers.tsx`

- [ ] **Step 1: Create the invalidation hook**

Create `packages/web/src/hooks/use-query-invalidation.ts`:

```typescript
"use client"

import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useGateway } from '@/hooks/use-gateway'
import { queryKeys } from '@/lib/query-keys'

/**
 * Subscribes to WebSocket events and invalidates React Query caches.
 * Mount once at app root (in client-providers.tsx).
 */
export function useQueryInvalidation() {
  const qc = useQueryClient()
  const gateway = useGateway()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const unsub = gateway.subscribe((event: string, payload: unknown) => {
      const p = payload as Record<string, unknown> | undefined

      switch (event) {
        case 'session:started':
          pendingRef.current.add('sessions')
          break
        case 'session:completed':
        case 'session:error':
          pendingRef.current.add('sessions')
          pendingRef.current.add('costs')
          if (p?.sessionId) {
            qc.invalidateQueries({ queryKey: queryKeys.sessions.detail(p.sessionId as string) })
          }
          break
        case 'cron:completed':
        case 'cron:error':
          pendingRef.current.add('cron')
          break
        case 'skills:changed':
          pendingRef.current.add('skills')
          break
        default:
          return // No invalidation for unknown events
      }

      // Debounce: flush pending invalidations after 500ms of quiet
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        for (const key of pendingRef.current) {
          switch (key) {
            case 'sessions':
              qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
              break
            case 'costs':
              qc.invalidateQueries({ queryKey: ['costs'] })
              break
            case 'cron':
              qc.invalidateQueries({ queryKey: queryKeys.cron.all })
              break
            case 'skills':
              qc.invalidateQueries({ queryKey: queryKeys.skills.all })
              break
          }
        }
        pendingRef.current.clear()
      }, 500)
    })

    return () => {
      unsub()
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [gateway, qc])
}
```

- [ ] **Step 2: Mount the invalidation hook in client-providers.tsx**

Add to `packages/web/src/app/client-providers.tsx`:

```typescript
import { useQueryInvalidation } from '@/hooks/use-query-invalidation'

// Create a small wrapper component to call the hook
function QueryInvalidationBridge() {
  useQueryInvalidation()
  return null
}
```

**Important note**: `useGateway()` is NOT context-based - it's a standalone hook that creates its own WebSocket connection internally. Each call creates a new connection. Mounting `useQueryInvalidation()` (which calls `useGateway()`) will create a separate WS connection from the ones used by chat, dashboard, etc. This is acceptable for invalidation purposes (the connection is lightweight). Accept the duplicate connection for now - refactoring `useGateway` into a context provider is a separate task.

Add `<QueryInvalidationBridge />` inside `QueryClientProvider` in `client-providers.tsx`, after the existing providers:

```tsx
<QueryClientProvider client={queryClient}>
  <ThemeProvider>
    <SettingsProvider>
      <NotificationProvider>
        {children}
        <DocumentTitle />
        <QueryInvalidationBridge />
      </NotificationProvider>
    </SettingsProvider>
  </ThemeProvider>
</QueryClientProvider>
```

- [ ] **Step 3: Verify build**

```bash
cd ~/Projects/cuttlefish && pnpm build
```

- [ ] **Step 4: Commit**

```bash
cd ~/Projects/cuttlefish
git add packages/web/src/hooks/use-query-invalidation.ts packages/web/src/app/client-providers.tsx
git commit -m "feat(web): add WS → React Query invalidation bridge with 500ms debounce"
```

---

## Phase 2: Chat Overhaul

### Task 7: Fix toolbar - move NotificationBell into header flow

**Files:**
- Modify: `packages/web/src/components/page-layout.tsx`
- Modify: `packages/web/src/app/chat/page.tsx`

This is the highest-priority UX fix. The notification bell is currently `position: fixed; top: 12px; right: 16px; z-index: 60` in `page-layout.tsx`, which collides with chat's header buttons.

- [ ] **Step 1: Remove fixed-position bell from page-layout.tsx**

In `packages/web/src/components/page-layout.tsx`, find the desktop NotificationBell wrapper (the `div` with `position: fixed, top: 12, right: 16, zIndex: 60`). Remove this entire fixed-position wrapper. The bell will be relocated into each page's header as a normal flex item.

- [ ] **Step 2: Create a shared ToolbarActions component**

Add to `packages/web/src/components/page-layout.tsx` (or a new file `toolbar-actions.tsx`):

```typescript
export function ToolbarActions({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      {children}
      <NotificationBell />
    </div>
  )
}
```

This ensures the bell is always the last item in the toolbar button group, rendered in normal document flow (not fixed).

- [ ] **Step 3: Update chat page header to include ToolbarActions**

In `packages/web/src/app/chat/page.tsx`, replace the current header's right-side button group with `<ToolbarActions>` wrapping the chat-specific buttons (session picker, view toggle, more menu). Ensure all buttons are 32×32px with 8px gap:

```tsx
<ToolbarActions>
  {/* Chat-specific buttons */}
  {splitToggle}
  {viewModeToggle}
  {moreMenu}
</ToolbarActions>
```

- [ ] **Step 4: Update all other pages' headers similarly**

Each page that renders a header should include `<ToolbarActions />` in its right side. For pages without custom toolbar buttons, just render `<ToolbarActions />` bare.

- [ ] **Step 5: Verify no z-index conflicts remain**

All dropdown menus from toolbar buttons should use the same z-index (e.g., `z-50`). Check that the notification dropdown, more menu dropdown, and session picker dropdown all use consistent z-index values.

- [ ] **Step 6: Verify build + manual test**

```bash
cd ~/Projects/cuttlefish && pnpm build
```

Manual: Open dashboard, navigate to chat. Verify bell + more menu don't overlap. Check mobile layout.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/components/page-layout.tsx packages/web/src/app/chat/page.tsx
git commit -m "fix(web): move notification bell into header flow, fix toolbar z-index conflicts"
```

---

### Task 8: Enhanced chat sidebar with expandable employee groups

**Files:**
- Modify: `packages/web/src/components/chat/chat-sidebar.tsx`

- [ ] **Step 1: Refactor sidebar data model**

Replace the current grouping logic (which only shows one entry per employee with no expand capability) with an expandable group model:

- Each employee group stores: `expanded: boolean` (in localStorage via `cuttlefish-sidebar-expanded` key)
- Collapsed: shows employee name, dept, session count badge, status dot, last message timestamp
- Expanded: shows up to 5 latest sessions inline with status dot + title + timestamp + 1-line message preview
- Add "Show all" link when employee has > 5 sessions

- [ ] **Step 2: Add session preview data**

When expanded, each session item shows:
- Status dot (running=blue pulse, error=red, unread=green, idle=gray)
- Session title or "Untitled" (truncated)
- Last message timestamp (relative: "2 min ago", "yesterday")
- Last message preview (1 line, max ~40 chars, assistant messages only)

The session list data comes from the existing `useSessions()` hook (or the current fetch). Filter by employee name and sort by `lastActivity` descending.

- [ ] **Step 3: Add pinned section at top**

Sessions can be pinned (already in localStorage as `cuttlefish-pinned-sessions`). Render pinned sessions at the top of the sidebar in their own section:

```
📌 Pinned
  ├ Session title (status dot)
  └ Session title (status dot)
```

- [ ] **Step 4: Add unread count badges**

Employee groups show an unread count badge (accent color pill) when they have sessions with unread messages. A session is "unread" if its ID is not in `cuttlefish-read-sessions` localStorage.

- [ ] **Step 5: Add context menu (right-click)**

Use the shadcn `ContextMenu` component (installed in Task 1). On right-click of any employee group or session item, show:
- Open in new tab (Phase 2 - wire up in Task 10)
- Pin / Unpin
- Mark all as read
- Delete session / Delete all for employee

- [ ] **Step 6: Verify build + manual test**

```bash
cd ~/Projects/cuttlefish && pnpm build
```

Manual: Open chat, verify employee groups expand/collapse, session previews show, pins work, context menu appears on right-click.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/components/chat/chat-sidebar.tsx
git commit -m "feat(web): enhanced chat sidebar with expandable employee groups, pins, previews, context menu"
```

---

### Task 9: Chat tab bar

**Files:**
- Create: `packages/web/src/hooks/use-chat-tabs.ts`
- Create: `packages/web/src/components/chat/chat-tabs.tsx`
- Modify: `packages/web/src/app/chat/page.tsx`

- [ ] **Step 1: Create tab state management hook**

Create `packages/web/src/hooks/use-chat-tabs.ts`:

```typescript
"use client"

import { useState, useCallback, useEffect } from 'react'

export interface ChatTab {
  sessionId: string
  label: string        // Employee name or session title
  emoji?: string       // Employee avatar emoji
  status: 'idle' | 'running' | 'error'
  unread: boolean
}

const STORAGE_KEY = 'cuttlefish-chat-tabs'
const DRAFT_PREFIX = 'cuttlefish-chat-draft-'
const MAX_TABS = 12

function loadTabs(): { tabs: ChatTab[]; activeIndex: number } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  return { tabs: [], activeIndex: -1 }
}

function saveTabs(tabs: ChatTab[], activeIndex: number) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs, activeIndex }))
}

export function useChatTabs() {
  const [tabs, setTabs] = useState<ChatTab[]>([])
  const [activeIndex, setActiveIndex] = useState(-1)

  // Load from localStorage on mount
  useEffect(() => {
    const { tabs: saved, activeIndex: idx } = loadTabs()
    setTabs(saved)
    setActiveIndex(idx)
  }, [])

  // Persist on change
  useEffect(() => {
    saveTabs(tabs, activeIndex)
  }, [tabs, activeIndex])

  const activeTab = activeIndex >= 0 ? tabs[activeIndex] : null

  const openTab = useCallback((tab: ChatTab) => {
    setTabs(prev => {
      const existing = prev.findIndex(t => t.sessionId === tab.sessionId)
      if (existing >= 0) {
        setActiveIndex(existing)
        return prev
      }
      if (prev.length >= MAX_TABS) {
        // Replace oldest non-active tab
        const replaceIdx = prev.findIndex((_, i) => i !== activeIndex)
        if (replaceIdx >= 0) {
          const next = [...prev]
          next[replaceIdx] = tab
          setActiveIndex(replaceIdx)
          return next
        }
      }
      setActiveIndex(prev.length)
      return [...prev, tab]
    })
  }, [activeIndex])

  const closeTab = useCallback((index: number) => {
    setTabs(prev => {
      const sessionId = prev[index]?.sessionId
      if (sessionId) localStorage.removeItem(DRAFT_PREFIX + sessionId)
      const next = prev.filter((_, i) => i !== index)
      // Adjust active index atomically using prev array length
      setActiveIndex(activeIdx => {
        if (activeIdx === index) return Math.min(index, next.length - 1)
        if (activeIdx > index) return activeIdx - 1
        return activeIdx
      })
      return next
    })
  }, [])

  const switchTab = useCallback((index: number) => {
    if (index >= 0 && index < tabs.length) setActiveIndex(index)
  }, [tabs.length])

  const nextTab = useCallback(() => {
    setActiveIndex(prev => (prev + 1) % tabs.length)
  }, [tabs.length])

  const prevTab = useCallback(() => {
    setActiveIndex(prev => (prev - 1 + tabs.length) % tabs.length)
  }, [tabs.length])

  // Draft persistence
  const saveDraft = useCallback((sessionId: string, text: string) => {
    if (text.trim()) {
      localStorage.setItem(DRAFT_PREFIX + sessionId, text)
    } else {
      localStorage.removeItem(DRAFT_PREFIX + sessionId)
    }
  }, [])

  const loadDraft = useCallback((sessionId: string) => {
    return localStorage.getItem(DRAFT_PREFIX + sessionId) || ''
  }, [])

  const updateTabStatus = useCallback((sessionId: string, updates: Partial<ChatTab>) => {
    setTabs(prev => prev.map(t =>
      t.sessionId === sessionId ? { ...t, ...updates } : t
    ))
  }, [])

  return {
    tabs, activeTab, activeIndex,
    openTab, closeTab, switchTab, nextTab, prevTab,
    saveDraft, loadDraft, updateTabStatus,
  }
}
```

- [ ] **Step 2: Create tab bar component**

Create `packages/web/src/components/chat/chat-tabs.tsx`:

```typescript
"use client"

import { useRef, type MouseEvent } from 'react'
import { X, Plus } from 'lucide-react'
import type { ChatTab } from '@/hooks/use-chat-tabs'

interface ChatTabBarProps {
  tabs: ChatTab[]
  activeIndex: number
  onSwitch: (index: number) => void
  onClose: (index: number) => void
  onNew: () => void
}

const STATUS_COLORS: Record<string, string> = {
  running: 'bg-blue-500 animate-pulse',
  error: 'bg-red-500',
  idle: 'bg-zinc-500',
}

export function ChatTabBar({ tabs, activeIndex, onSwitch, onClose, onNew }: ChatTabBarProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  if (tabs.length === 0) return null

  const handleMiddleClick = (e: MouseEvent, index: number) => {
    if (e.button === 1) { e.preventDefault(); onClose(index) }
  }

  return (
    <div className="flex items-center border-b border-[var(--separator)] bg-[var(--bg-secondary)] h-9 shrink-0 overflow-hidden">
      <div ref={scrollRef} className="flex items-center flex-1 overflow-x-auto scrollbar-none">
        {tabs.map((tab, i) => (
          <button
            key={tab.sessionId}
            onClick={() => onSwitch(i)}
            onMouseDown={(e) => handleMiddleClick(e, i)}
            className={`group flex items-center gap-1.5 px-3 h-9 text-xs font-medium whitespace-nowrap border-r border-[var(--separator)] transition-colors shrink-0 max-w-[160px] ${
              i === activeIndex
                ? 'bg-[var(--bg)] text-[var(--text-primary)] border-b-2 border-b-[var(--accent)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--fill-quaternary)]'
            } ${tab.unread && i !== activeIndex ? 'font-bold' : ''}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_COLORS[tab.status] || STATUS_COLORS.idle}`} />
            {tab.emoji && <span className="text-sm">{tab.emoji}</span>}
            <span className="truncate">{tab.label}</span>
            <span
              onClick={(e) => { e.stopPropagation(); onClose(i) }}
              className="ml-auto opacity-0 group-hover:opacity-100 hover:text-[var(--text-primary)] transition-opacity p-0.5"
            >
              <X size={12} />
            </span>
          </button>
        ))}
      </div>
      <button
        onClick={onNew}
        className="flex items-center justify-center w-9 h-9 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--fill-quaternary)] shrink-0 transition-colors"
        title="New Chat"
      >
        <Plus size={14} />
      </button>
    </div>
  )
}
```

- [ ] **Step 3: Wire keyboard shortcuts**

Add to `packages/web/src/app/chat/page.tsx` a `useEffect` that listens for:
- `Cmd+W` → close active tab
- `Cmd+Shift+[` → prev tab
- `Cmd+Shift+]` → next tab
- `Cmd+Alt+1-9` → switch to tab by index

```typescript
useEffect(() => {
  function handleKeyDown(e: KeyboardEvent) {
    if (e.metaKey && e.key === 'w') {
      e.preventDefault()
      if (chatTabs.activeIndex >= 0) chatTabs.closeTab(chatTabs.activeIndex)
    }
    if (e.metaKey && e.shiftKey && e.key === '[') {
      e.preventDefault()
      chatTabs.prevTab()
    }
    if (e.metaKey && e.shiftKey && e.key === ']') {
      e.preventDefault()
      chatTabs.nextTab()
    }
    if (e.metaKey && e.altKey && e.key >= '1' && e.key <= '9') {
      e.preventDefault()
      chatTabs.switchTab(parseInt(e.key) - 1)
    }
  }
  window.addEventListener('keydown', handleKeyDown)
  return () => window.removeEventListener('keydown', handleKeyDown)
}, [chatTabs])
```

- [ ] **Step 4: Integrate tab bar into chat page**

In `packages/web/src/app/chat/page.tsx`:
1. Initialize `useChatTabs()` hook
2. When sidebar selects a session, call `chatTabs.openTab(...)` instead of just `setSelectedId()`
3. Render `<ChatTabBar />` between the header and the chat content area
4. The active tab's `sessionId` drives which session is displayed
5. When switching tabs, restore the draft text for the new active tab

- [ ] **Step 5: Verify build + manual test**

```bash
cd ~/Projects/cuttlefish && pnpm build
```

Manual: Open chat, click multiple employees → tabs appear, switch between tabs, close tabs, keyboard shortcuts work, drafts persist.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/hooks/use-chat-tabs.ts packages/web/src/components/chat/chat-tabs.tsx packages/web/src/app/chat/page.tsx
git commit -m "feat(web): chat tab bar with keyboard shortcuts, draft persistence, and status indicators"
```

---

### Task 10: Extract ChatPane component

**Files:**
- Create: `packages/web/src/components/chat/chat-pane.tsx`
- Modify: `packages/web/src/app/chat/page.tsx`

The current `chat/page.tsx` is ~1092 lines with all chat logic inline. We need to extract the core chat display (messages + input + streaming) into a reusable `ChatPane` component that can be instantiated multiple times for split view.

- [ ] **Step 1: Extract ChatPane from page.tsx**

Create `packages/web/src/components/chat/chat-pane.tsx`. This component receives:
- `sessionId: string | null` - which session to display
- `isActive: boolean` - whether this pane has focus (for border highlight)
- `onFocus: () => void` - called when user clicks in this pane

It encapsulates:
- Message loading + display (ChatMessages)
- Streaming text state
- Input box (ChatInput)
- WebSocket subscription for this session's events
- Scroll position management (preserved per sessionId)
- View mode toggle (chat/cli)

- [ ] **Step 2: Move state from page.tsx into ChatPane**

The following state moves from `page.tsx` into `ChatPane`:
- `messages`, `loading`, `streamingText`, `streamingTextRef`
- `sessionMeta`, `employeeSessions`
- `viewMode`, `showMoreMenu`
- The WebSocket `subscribe()` callback that handles `session:delta`, `session:notification`, `session:completed`
- The `loadSession()`, `sendMessage()` functions

What stays in `page.tsx`:
- Tab state (`useChatTabs`)
- Split mode state
- Sidebar state
- Global keyboard shortcuts

- [ ] **Step 3: Simplify page.tsx to render ChatPane(s)**

After extraction, `page.tsx` becomes:
```tsx
<div className="flex h-full">
  <ChatSidebar ... />
  <div className="flex flex-col flex-1">
    <ChatTabBar ... />
    <ChatPane
      sessionId={activeTab?.sessionId ?? null}
      isActive={true}
      onFocus={() => {}}
    />
  </div>
</div>
```

- [ ] **Step 4: Verify build + test that existing chat still works**

```bash
cd ~/Projects/cuttlefish && pnpm build
```

Manual: Open chat, send message, verify streaming works, verify all existing functionality intact.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/chat/chat-pane.tsx packages/web/src/app/chat/page.tsx
git commit -m "refactor(web): extract ChatPane component from chat page for reuse in split view"
```

---

### Task 11: Split view

**Files:**
- Create: `packages/web/src/components/chat/chat-split.tsx`
- Modify: `packages/web/src/app/chat/page.tsx`

- [ ] **Step 1: Create split view container**

Create `packages/web/src/components/chat/chat-split.tsx`:

```typescript
"use client"

import { useState, useCallback, useRef } from 'react'
import { ChatPane } from './chat-pane'

export type SplitMode = 1 | 2 | 3

interface ChatSplitProps {
  mode: SplitMode
  paneSessionIds: (string | null)[]  // One per pane
  activePaneIndex: number
  onPaneFocus: (index: number) => void
}

export function ChatSplit({ mode, paneSessionIds, activePaneIndex, onPaneFocus }: ChatSplitProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  // Only render `mode` number of panes
  const panes = paneSessionIds.slice(0, mode)

  return (
    <div ref={containerRef} className="flex flex-1 overflow-hidden">
      {panes.map((sessionId, i) => (
        <div
          key={i}
          className={`flex flex-col flex-1 min-w-[300px] ${
            i < panes.length - 1 ? 'border-r border-[var(--separator)]' : ''
          } ${i === activePaneIndex ? 'ring-1 ring-inset ring-[var(--accent)]/30' : ''}`}
          onClick={() => onPaneFocus(i)}
        >
          <ChatPane
            sessionId={sessionId}
            isActive={i === activePaneIndex}
            onFocus={() => onPaneFocus(i)}
          />
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Add split mode state + toggle to chat page**

In `packages/web/src/app/chat/page.tsx`:

```typescript
const [splitMode, setSplitMode] = useState<SplitMode>(1)
const [paneSessionIds, setPaneSessionIds] = useState<(string | null)[]>([null, null, null])
const [activePaneIndex, setActivePaneIndex] = useState(0)

// Cycle split modes
const cycleSplit = () => setSplitMode(prev => ((prev % 3) + 1) as SplitMode)
```

When a tab is selected, assign its sessionId to the active pane:
```typescript
// When tab changes → assign to active pane
useEffect(() => {
  if (activeTab) {
    setPaneSessionIds(prev => {
      const next = [...prev]
      next[activePaneIndex] = activeTab.sessionId
      return next
    })
  }
}, [activeTab, activePaneIndex])
```

- [ ] **Step 3: Add split toggle button to toolbar**

Add a split toggle (1/2/3 pane icons) to the toolbar's `ToolbarActions`:

```tsx
<button onClick={cycleSplit} className="..." title={`Split: ${splitMode} pane${splitMode > 1 ? 's' : ''}`}>
  {splitMode === 1 ? <Square size={16} /> : splitMode === 2 ? <Columns2 size={16} /> : <Columns3 size={16} />}
</button>
```

Import `Square`, `Columns2`, `Columns3` from `lucide-react`.

- [ ] **Step 4: Add keyboard shortcut**

`Cmd+\` → cycle split modes
`Cmd+Alt+1/2/3` → focus pane (when splitMode > 1)

- [ ] **Step 5: Disable split on mobile**

In the split toggle button, add `className="hidden lg:flex ..."`. On screens < lg, always render a single ChatPane.

- [ ] **Step 6: Verify build + manual test**

```bash
cd ~/Projects/cuttlefish && pnpm build
```

Manual: Toggle split mode, verify 2-pane and 3-pane layouts, verify each pane independently streams, verify pane focus indicator.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/components/chat/chat-split.tsx packages/web/src/app/chat/page.tsx
git commit -m "feat(web): split view for active multitasking - 1/2/3 panes with independent chat sessions"
```

---

## Phase 3: Command Palette + Navigation

### Task 12: Breadcrumb context + component

**Files:**
- Create: `packages/web/src/context/breadcrumb-context.tsx`
- Create: `packages/web/src/components/breadcrumb-bar.tsx`
- Modify: `packages/web/src/app/client-providers.tsx`
- Modify: `packages/web/src/components/page-layout.tsx`

- [ ] **Step 1: Create BreadcrumbContext**

Create `packages/web/src/context/breadcrumb-context.tsx`:

```typescript
"use client"

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react'

interface BreadcrumbItem {
  label: string
  href?: string
}

interface BreadcrumbContextValue {
  items: BreadcrumbItem[]
  setItems: (items: BreadcrumbItem[]) => void
}

const BreadcrumbContext = createContext<BreadcrumbContextValue>({
  items: [],
  setItems: () => {},
})

export function BreadcrumbProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<BreadcrumbItem[]>([])

  // Update document.title when breadcrumbs change
  useEffect(() => {
    if (items.length > 0) {
      const trail = items.map(i => i.label).join(' > ')
      document.title = `${trail} - Cuttlefish`
    }
  }, [items])

  return (
    <BreadcrumbContext.Provider value={{ items, setItems }}>
      {children}
    </BreadcrumbContext.Provider>
  )
}

export function useBreadcrumbs(items?: BreadcrumbItem[]) {
  const ctx = useContext(BreadcrumbContext)

  // Serialize items for stable dependency comparison
  const itemsKey = items ? JSON.stringify(items) : ''

  useEffect(() => {
    if (items) ctx.setItems(items)
  }, [itemsKey]) // eslint-disable-line react-hooks/exhaustive-deps
  // itemsKey changes when labels/hrefs change, enabling dynamic breadcrumbs
  // (e.g., Chat > employee-A → Chat > employee-B)

  return ctx
}
```

- [ ] **Step 2: Create BreadcrumbBar component**

Create `packages/web/src/components/breadcrumb-bar.tsx`:

```typescript
"use client"

import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { useBreadcrumbs } from '@/context/breadcrumb-context'

export function BreadcrumbBar() {
  const { items } = useBreadcrumbs()

  if (items.length === 0) return null

  // Single breadcrumb → render as page title
  if (items.length === 1) {
    return (
      <h1 className="text-lg font-semibold text-[var(--text-primary)] tracking-tight">
        {items[0].label}
      </h1>
    )
  }

  // Multiple → trail with separators
  return (
    <nav className="flex items-center gap-1.5 text-sm" aria-label="Breadcrumb">
      {items.map((item, i) => {
        const isLast = i === items.length - 1
        return (
          <span key={i} className="flex items-center gap-1.5">
            {i > 0 && <ChevronRight size={14} className="text-[var(--text-quaternary)]" />}
            {isLast || !item.href ? (
              <span className={isLast ? 'text-[var(--text-primary)] font-medium' : 'text-[var(--text-tertiary)]'}>
                {item.label}
              </span>
            ) : (
              <Link href={item.href} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors">
                {item.label}
              </Link>
            )}
          </span>
        )
      })}
    </nav>
  )
}
```

- [ ] **Step 3: Add BreadcrumbProvider to client-providers.tsx**

Wrap inside the existing provider tree (after `ThemeProvider`).

- [ ] **Step 4: Add BreadcrumbBar to page-layout.tsx header**

Replace the static page title in the header with `<BreadcrumbBar />`.

- [ ] **Step 5: Wire breadcrumbs into each page**

Each page adds `useBreadcrumbs()` on mount. Examples:
- Dashboard: `useBreadcrumbs([{ label: 'Dashboard' }])`
- Chat: `useBreadcrumbs([{ label: 'Chat', href: '/chat' }])` - updates to `[{ label: 'Chat', href: '/chat' }, { label: employeeName }]` when session selected
- Cron: `useBreadcrumbs([{ label: 'Cron' }])`
- Settings: `useBreadcrumbs([{ label: 'Settings' }])`

- [ ] **Step 6: Verify build + manual test**

```bash
cd ~/Projects/cuttlefish && pnpm build
```

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/context/breadcrumb-context.tsx packages/web/src/components/breadcrumb-bar.tsx packages/web/src/app/client-providers.tsx packages/web/src/components/page-layout.tsx
git commit -m "feat(web): breadcrumb navigation context + component, wired into all pages"
```

---

### Task 13: Replace GlobalSearch with cmdk command palette

**Files:**
- Modify: `packages/web/src/components/global-search.tsx`

- [ ] **Step 1: Rewrite global-search.tsx using cmdk + shadcn Command**

Replace the hand-rolled search modal internals with the shadcn `Command` component (which wraps cmdk). Keep the `Cmd+K` keybinding and modal overlay structure.

Key changes:
- Replace custom search input with `<CommandInput />`
- Replace custom result list with `<CommandList>`, `<CommandGroup>`, `<CommandItem>`
- Replace custom keyboard handling with cmdk's built-in arrow/enter/escape
- Replace raw `fetch` calls with React Query hooks (`useOrg()`, `useCronJobs()`, `useSessions()`, `useSkills()`)
- Add new sections: Recent (localStorage), Actions (New Chat, Toggle Theme), Sessions, Skills

```tsx
import { Command, CommandInput, CommandList, CommandGroup, CommandItem, CommandEmpty, CommandSeparator } from '@/components/ui/command'
import { Dialog, DialogContent } from '@/components/ui/dialog'
```

- [ ] **Step 2: Add Actions group**

Static actions:
- "New Chat" → navigate to `/chat` with empty session
- "New Chat with..." → submenu showing employees, on select creates session
- "Toggle Theme" → cycle through themes
- "Trigger Cron Job..." → submenu showing cron jobs

- [ ] **Step 3: Add Recent items**

Track last 5 used command palette items in `localStorage` key `cuttlefish-command-recent`. On each item selection, push to recents list (dedup by id, max 5). Show as first group when search is empty.

- [ ] **Step 4: Add Sessions search**

New group that shows active sessions (from `useSessions()`), filterable by title. On select, navigate to `/chat` and open the session in a tab.

- [ ] **Step 5: Add Skills group**

Show installed skills (from `useSkills()`). On select, if on chat page, insert the skill's slash command into the active chat input.

- [ ] **Step 6: Verify build + manual test**

```bash
cd ~/Projects/cuttlefish && pnpm build
```

Manual: Press Cmd+K, verify search works, navigate to pages, create new chat from palette, verify recent items persist.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/components/global-search.tsx
git commit -m "feat(web): replace GlobalSearch with cmdk command palette - actions, recents, sessions, skills"
```

---

## Phase 4: New Capabilities

### Task 14: Goals - backend SQLite table + API routes

**Files:**
- Create: `packages/cuttlefish/src/gateway/goals.ts`
- Modify: `packages/cuttlefish/src/gateway/api.ts`
- Modify: `packages/cuttlefish/src/sessions/registry.ts`
- Modify: `packages/cuttlefish/src/shared/types.ts`

- [ ] **Step 1: Add Goal type to types.ts**

In `packages/cuttlefish/src/shared/types.ts`:

```typescript
export interface Goal {
  id: string;
  title: string;
  description: string | null;
  status: 'not_started' | 'in_progress' | 'at_risk' | 'completed';
  level: 'company' | 'department' | 'task';
  parentId: string | null;
  department: string | null;
  owner: string | null;
  progress: number;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 2: Add goals table migration to registry.ts**

In `packages/cuttlefish/src/sessions/registry.ts`, add to the `initDb()` function (after sessions/messages/queue_items tables):

```typescript
db.exec(`
  CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'not_started',
    level TEXT NOT NULL DEFAULT 'company',
    parent_id TEXT,
    department TEXT,
    owner TEXT,
    progress INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (parent_id) REFERENCES goals(id)
  )
`);
```

- [ ] **Step 3: Create goals.ts with CRUD functions**

Create `packages/cuttlefish/src/gateway/goals.ts` with:
- `listGoals(db, filters?)` → `Goal[]`
- `getGoalTree(db)` → nested `Goal[]` (recursive parent→children)
- `getGoal(db, id)` → `Goal | null`
- `createGoal(db, data)` → `Goal`
- `updateGoal(db, id, updates)` → `Goal`
- `deleteGoal(db, id)` → cascading delete children
- `getGoalTasks(db, goalId)` → scans department board JSONs for tasks with `goalId`

- [ ] **Step 4: Register API routes in api.ts**

Add to `packages/cuttlefish/src/gateway/api.ts`:
- `GET /api/goals` → `listGoals()`
- `GET /api/goals/tree` → `getGoalTree()`
- `GET /api/goals/:id` → `getGoal()`
- `POST /api/goals` → `createGoal()`
- `PUT /api/goals/:id` → `updateGoal()`
- `DELETE /api/goals/:id` → `deleteGoal()`
- `GET /api/goals/:id/tasks` → `getGoalTasks()`

Follow the existing `matchRoute()` pattern.

- [ ] **Step 5: Verify build**

```bash
cd ~/Projects/cuttlefish && pnpm build
```

- [ ] **Step 6: Commit**

```bash
git add packages/cuttlefish/src/gateway/goals.ts packages/cuttlefish/src/gateway/api.ts packages/cuttlefish/src/sessions/registry.ts packages/cuttlefish/src/shared/types.ts
git commit -m "feat(api): goals hierarchy - SQLite table, CRUD API routes, tree structure"
```

---

### Task 15: Goals - frontend page

**Files:**
- Create: `packages/web/src/hooks/use-goals.ts`
- Create: `packages/web/src/app/goals/page.tsx`
- Modify: `packages/web/src/lib/api.ts`
- Modify: sidebar navigation to include Goals link

- [ ] **Step 1: Add goals API functions to lib/api.ts**

```typescript
export function getGoals() { return get<Goal[]>('/api/goals') }
export function getGoalTree() { return get<Goal[]>('/api/goals/tree') }
export function getGoal(id: string) { return get<Goal>(`/api/goals/${id}`) }
export function createGoal(data: Partial<Goal>) { return post<Goal>('/api/goals', data) }
export function updateGoal(id: string, data: Partial<Goal>) { return put<Goal>(`/api/goals/${id}`, data) }
export function deleteGoal(id: string) { return del(`/api/goals/${id}`) }
```

- [ ] **Step 2: Create goals query hooks**

Create `packages/web/src/hooks/use-goals.ts` with `useGoals()`, `useGoalTree()`, `useGoal(id)`, `useCreateGoal()`, `useUpdateGoal()`, `useDeleteGoal()`.

- [ ] **Step 3: Create goals page**

Create `packages/web/src/app/goals/page.tsx`:
- Tree view with expand/collapse
- Each node: title, status badge (shadcn Badge), progress bar, owner, child count
- Click goal → inline detail panel (right side) with edit form
- "New Goal" button → shadcn Dialog with form
- Filter bar: by status, department, level

- [ ] **Step 4: Add Goals to sidebar navigation**

Add a "Goals" nav item with the `Target` icon from lucide-react, linking to `/goals`.

- [ ] **Step 5: Verify build + manual test**

```bash
cd ~/Projects/cuttlefish && pnpm build
```

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/hooks/use-goals.ts packages/web/src/app/goals/page.tsx packages/web/src/lib/api.ts
git commit -m "feat(web): goals page with tree view, inline detail panel, CRUD operations"
```

---

### Task 16: Cost aggregation API (backend)

**Files:**
- Create: `packages/cuttlefish/src/gateway/costs.ts`
- Modify: `packages/cuttlefish/src/gateway/api.ts`

- [ ] **Step 1: Create costs.ts with aggregation queries**

Create `packages/cuttlefish/src/gateway/costs.ts`:

```typescript
import { initDb } from '../sessions/registry.js';

export interface CostSummary {
  total: number;
  daily: { date: string; cost: number }[];
  byEmployee: { employee: string; cost: number; sessions: number }[];
  byDepartment: { department: string; cost: number }[];
}

export function getCostSummary(period: 'day' | 'week' | 'month' = 'month'): CostSummary {
  const db = initDb();

  // Compute date cutoff in JS, pass as parameter (never interpolate into SQL)
  const now = new Date();
  let cutoff: string;
  if (period === 'day') {
    cutoff = now.toISOString().slice(0, 10); // YYYY-MM-DD
  } else if (period === 'week') {
    const d = new Date(now); d.setDate(d.getDate() - 7);
    cutoff = d.toISOString().slice(0, 10);
  } else {
    cutoff = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  }

  const total = db.prepare(
    'SELECT COALESCE(SUM(total_cost), 0) as total FROM sessions WHERE created_at >= ?'
  ).get(cutoff) as { total: number };

  const thirtyDaysAgo = new Date(now); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const daily = db.prepare(
    `SELECT date(created_at) as date, SUM(total_cost) as cost
     FROM sessions WHERE created_at >= ?
     GROUP BY date(created_at) ORDER BY date`
  ).all(thirtyDaysAgo.toISOString().slice(0, 10)) as { date: string; cost: number }[];

  const byEmployee = db.prepare(
    `SELECT COALESCE(employee, 'direct') as employee, SUM(total_cost) as cost, COUNT(*) as sessions
     FROM sessions WHERE created_at >= ?
     GROUP BY employee ORDER BY cost DESC`
  ).all(cutoff) as { employee: string; cost: number; sessions: number }[];

  // Department lookup would require joining with org data
  // For now, return byEmployee and let frontend group by department
  return { total: total.total, daily, byEmployee, byDepartment: [] };
}

export function getCostsByEmployee(period: 'month' | 'week' = 'month') {
  const db = initDb();
  const dateFilter = period === 'month'
    ? "date('now', 'start of month')"
    : "date('now', '-7 days')";

  return db.prepare(
    `SELECT COALESCE(employee, 'direct') as employee, SUM(total_cost) as cost, COUNT(*) as sessions,
            SUM(total_turns) as turns
     FROM sessions WHERE created_at >= ${dateFilter}
     GROUP BY employee ORDER BY cost DESC`
  ).all();
}
```

- [ ] **Step 2: Register cost routes in api.ts**

Add to `packages/cuttlefish/src/gateway/api.ts`:
- `GET /api/costs/summary?period=day|week|month` → `getCostSummary(period)`
- `GET /api/costs/by-employee?period=month|week` → `getCostsByEmployee(period)`

- [ ] **Step 3: Verify build**

```bash
cd ~/Projects/cuttlefish && pnpm build
```

- [ ] **Step 4: Commit**

```bash
git add packages/cuttlefish/src/gateway/costs.ts packages/cuttlefish/src/gateway/api.ts
git commit -m "feat(api): cost aggregation API - summary by period, breakdown by employee"
```

---

### Task 17: Budget system (backend)

**Files:**
- Create: `packages/cuttlefish/src/gateway/budgets.ts`
- Modify: `packages/cuttlefish/src/gateway/api.ts`
- Modify: `packages/cuttlefish/src/sessions/registry.ts`
- Modify: `packages/cuttlefish/src/sessions/manager.ts`

- [ ] **Step 1: Add budget_events table to registry.ts**

```typescript
db.exec(`
  CREATE TABLE IF NOT EXISTS budget_events (
    id TEXT PRIMARY KEY,
    employee TEXT NOT NULL,
    event_type TEXT NOT NULL,
    amount REAL NOT NULL,
    limit_amount REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
```

- [ ] **Step 2: Create budgets.ts**

Functions:
- `getBudgets(config)` → reads `budgets` section from config.yaml
- `getEmployeeBudgetStatus(db, config, employee)` → current spend vs limit, returns { spend, limit, percent, action }
- `checkBudget(db, config, employee)` → returns 'ok' | 'warning' | 'exceeded' | 'paused'
- `recordBudgetEvent(db, employee, type, amount, limit)`
- `getBudgetEvents(db, limit?)` → recent events
- `overrideBudget(db, employee)` → record override event, allow one session

- [ ] **Step 3: Add budget enforcement to SessionManager.route()**

In `packages/cuttlefish/src/sessions/manager.ts`, in the `runSession()` method, BEFORE calling `engine.run()`:

```typescript
// Budget check
if (session.employee && config.budgets?.employees?.[session.employee]) {
  const status = checkBudget(db, config, session.employee);
  if (status === 'paused') {
    // Refuse to run, emit budget:paused event
    context.emit('budget:paused', { employee: session.employee });
    updateSession(session.id, { status: 'error', lastError: 'Budget exceeded' });
    return;
  }
  if (status === 'warning') {
    context.emit('budget:warning', { employee: session.employee });
  }
}
```

- [ ] **Step 4: Register budget API routes**

- `GET /api/budgets` → budget config + current status per employee
- `PUT /api/budgets` → update budget limits in config.yaml
- `POST /api/budgets/:employee/override` → allow one session past limit
- `GET /api/budgets/events` → recent budget events

- [ ] **Step 5: Verify build**

```bash
cd ~/Projects/cuttlefish && pnpm build
```

- [ ] **Step 6: Commit**

```bash
git add packages/cuttlefish/src/gateway/budgets.ts packages/cuttlefish/src/gateway/api.ts packages/cuttlefish/src/sessions/registry.ts packages/cuttlefish/src/sessions/manager.ts
git commit -m "feat(api): budget system - config-driven limits, enforcement before engine.run(), override support"
```

---

### Task 18: Costs page frontend fix

**Files:**
- Modify: `packages/web/src/lib/api.ts`
- Create: `packages/web/src/hooks/use-costs.ts`
- Modify: `packages/web/src/components/costs/costs-page.tsx` (or `packages/web/src/app/costs/page.tsx`)

- [ ] **Step 1: Add costs/budgets API functions to lib/api.ts**

```typescript
export function getCostSummary(period = 'month') { return get(`/api/costs/summary?period=${period}`) }
export function getCostsByEmployee(period = 'month') { return get(`/api/costs/by-employee?period=${period}`) }
export function getBudgets() { return get('/api/budgets') }
export function updateBudgets(data: unknown) { return put('/api/budgets', data) }
export function overrideBudget(employee: string) { return post(`/api/budgets/${employee}/override`, {}) }
export function getBudgetEvents() { return get('/api/budgets/events') }
```

- [ ] **Step 2: Create costs query hooks**

Create `packages/web/src/hooks/use-costs.ts` with `useCostSummary(period)`, `useCostsByEmployee(period)`, `useBudgets()`, `useUpdateBudgets()`, `useOverrideBudget()`, `useBudgetEvents()`.

- [ ] **Step 3: Rewrite costs page to use real data**

Replace the current costs page content with:
- Summary cards (total spend, daily avg, projected month-end) - using `useCostSummary()`
- Daily spend bar chart (last 30 days) - simple CSS bars or a lightweight chart lib
- Per-employee table with budget progress bars - using `useCostsByEmployee()` + `useBudgets()`
- Budget event log - using `useBudgetEvents()`
- Inline budget editor - edit monthly limits per employee

- [ ] **Step 4: Verify build + manual test**

```bash
cd ~/Projects/cuttlefish && pnpm build
```

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/api.ts packages/web/src/hooks/use-costs.ts packages/web/src/components/costs/ packages/web/src/app/costs/
git commit -m "feat(web): working costs page with real data, budget progress bars, event log"
```

---

## Phase 5: Testing + CI

### Task 19: Vitest backend setup + first tests

**Files:**
- Create: `packages/cuttlefish/vitest.config.ts`
- Modify: `packages/cuttlefish/package.json`
- Create: `packages/cuttlefish/src/gateway/__tests__/costs.test.ts`

- [ ] **Step 1: Install vitest**

```bash
cd ~/Projects/cuttlefish/packages/cuttlefish
pnpm add -D vitest
```

- [ ] **Step 2: Create vitest config**

Create `packages/cuttlefish/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
```

- [ ] **Step 3: Add test script to package.json**

In `packages/cuttlefish/package.json`, add to scripts:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Write first test - cost aggregation**

Create `packages/cuttlefish/src/gateway/__tests__/costs.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
// Test that getCostSummary correctly aggregates session costs
// Use in-memory SQLite for isolation

describe('getCostSummary', () => {
  it('returns zero when no sessions exist', () => {
    // Setup in-memory DB, call getCostSummary, assert total === 0
  })

  it('aggregates costs by employee', () => {
    // Insert 3 sessions with different employees, assert byEmployee breakdown
  })

  it('filters by period', () => {
    // Insert sessions across different dates, assert period filtering works
  })
})
```

- [ ] **Step 5: Run tests**

```bash
cd ~/Projects/cuttlefish/packages/cuttlefish && pnpm test
```

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/cuttlefish/vitest.config.ts packages/cuttlefish/package.json packages/cuttlefish/src/gateway/__tests__/
git commit -m "test(api): vitest setup + cost aggregation unit tests"
```

---

### Task 20: Vitest frontend setup + first tests

**Files:**
- Create: `packages/web/vitest.config.ts`
- Modify: `packages/web/package.json`
- Create: `packages/web/src/hooks/__tests__/use-chat-tabs.test.ts`

- [ ] **Step 1: Install vitest + testing library**

```bash
cd ~/Projects/cuttlefish/packages/web
pnpm add -D vitest @testing-library/react @testing-library/user-event jsdom
```

- [ ] **Step 2: Create vitest config**

Create `packages/web/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: [],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
})
```

- [ ] **Step 3: Add test script to package.json**

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Write first test - chat tabs hook**

Create `packages/web/src/hooks/__tests__/use-chat-tabs.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useChatTabs } from '../use-chat-tabs'

describe('useChatTabs', () => {
  beforeEach(() => localStorage.clear())

  it('starts with no tabs', () => {
    const { result } = renderHook(() => useChatTabs())
    expect(result.current.tabs).toHaveLength(0)
    expect(result.current.activeTab).toBeNull()
  })

  it('opens a tab and makes it active', () => {
    const { result } = renderHook(() => useChatTabs())
    act(() => result.current.openTab({ sessionId: 's1', label: 'Test', status: 'idle', unread: false }))
    expect(result.current.tabs).toHaveLength(1)
    expect(result.current.activeIndex).toBe(0)
  })

  it('does not duplicate existing tabs', () => {
    const { result } = renderHook(() => useChatTabs())
    const tab = { sessionId: 's1', label: 'Test', status: 'idle' as const, unread: false }
    act(() => result.current.openTab(tab))
    act(() => result.current.openTab(tab))
    expect(result.current.tabs).toHaveLength(1)
  })

  it('closes a tab and adjusts active index', () => {
    const { result } = renderHook(() => useChatTabs())
    act(() => result.current.openTab({ sessionId: 's1', label: 'A', status: 'idle', unread: false }))
    act(() => result.current.openTab({ sessionId: 's2', label: 'B', status: 'idle', unread: false }))
    act(() => result.current.closeTab(0))
    expect(result.current.tabs).toHaveLength(1)
    expect(result.current.tabs[0].sessionId).toBe('s2')
  })
})
```

- [ ] **Step 5: Run tests**

```bash
cd ~/Projects/cuttlefish/packages/web && pnpm test
```

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/web/vitest.config.ts packages/web/package.json packages/web/src/hooks/__tests__/
git commit -m "test(web): vitest setup + chat tabs hook unit tests"
```

---

### Task 21: Update Turborepo + root scripts

**Files:**
- Modify: `turbo.json`
- Modify: `package.json` (root)

- [ ] **Step 1: Add test task to turbo.json**

Add to the `tasks` object in `turbo.json`:

```json
"test": {
  "dependsOn": ["^build"],
  "cache": false
}
```

- [ ] **Step 2: Update root package.json test script**

Change the root `test` script to:

```json
"test": "turbo run test"
```

This runs tests in both packages/cuttlefish and packages/web.

- [ ] **Step 3: Verify**

```bash
cd ~/Projects/cuttlefish && pnpm test
```

Expected: Both backend and frontend tests run and pass.

- [ ] **Step 4: Commit**

```bash
git add turbo.json package.json
git commit -m "build: add test task to Turborepo pipeline, update root test script"
```

---

### Task 22: Mock engine for E2E tests

**Files:**
- Create: `packages/cuttlefish/src/engines/mock.ts`

- [ ] **Step 1: Create MockEngine**

Create `packages/cuttlefish/src/engines/mock.ts`:

```typescript
import { v4 as uuid } from 'uuid';
import type { Engine, EngineRunOpts, EngineResult } from '../shared/types.js';

/**
 * Mock engine for E2E tests. Returns canned responses with simulated streaming.
 */
export class MockEngine implements Engine {
  name = 'mock';

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const sessionId = opts.resumeSessionId || uuid();
    const response = `Mock response to: ${opts.prompt.slice(0, 100)}`;
    const words = response.split(' ');

    // Simulate streaming if onStream callback provided
    if (opts.onStream) {
      for (const word of words) {
        await new Promise(r => setTimeout(r, 50));
        opts.onStream!({ type: 'text', text: word + ' ' });
      }
    }

    return {
      sessionId,
      result: response,
      cost: 0.001,
      durationMs: words.length * 50,
      numTurns: 1,
    };
  }
}
```

- [ ] **Step 2: Verify build**

```bash
cd ~/Projects/cuttlefish && pnpm build
```

- [ ] **Step 3: Commit**

```bash
git add packages/cuttlefish/src/engines/mock.ts
git commit -m "feat(api): mock engine for E2E tests - canned responses with simulated streaming"
```

---

### Task 23: Playwright setup + smoke tests

**Files:**
- Create: `playwright.config.ts`
- Create: `e2e/global-setup.ts`
- Create: `e2e/smoke.spec.ts`
- Modify: Root `package.json`

- [ ] **Step 1: Install Playwright**

```bash
cd ~/Projects/cuttlefish
pnpm add -D @playwright/test
npx playwright install chromium
```

- [ ] **Step 2: Create Playwright config**

Create `playwright.config.ts`:

```typescript
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:7778',
    headless: true,
  },
  webServer: {
    command: 'CUTTLEFISH_TEST_MODE=1 CUTTLEFISH_PORT=7778 node packages/cuttlefish/dist/bin/cuttlefish.js start --foreground',
    port: 7778,
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
})
```

- [ ] **Step 3: Create smoke test**

Create `e2e/smoke.spec.ts`:

```typescript
import { test, expect } from '@playwright/test'

test('dashboard loads', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle(/Cuttlefish/)
  // Verify main nav links are present
  await expect(page.getByRole('link', { name: /chat/i })).toBeVisible()
  await expect(page.getByRole('link', { name: /cron/i })).toBeVisible()
})

test('chat page loads', async ({ page }) => {
  await page.goto('/chat')
  // Should show new chat or sidebar
  await expect(page.locator('text=New Chat').first()).toBeVisible()
})

test('no console errors on dashboard', async ({ page }) => {
  const errors: string[] = []
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) })
  await page.goto('/')
  await page.waitForTimeout(2000)
  expect(errors).toHaveLength(0)
})
```

- [ ] **Step 4: Add e2e script to root package.json**

```json
"test:e2e": "playwright test"
```

- [ ] **Step 5: Run E2E tests**

```bash
cd ~/Projects/cuttlefish && pnpm build && pnpm test:e2e
```

Expected: All smoke tests pass. (Requires gateway to start in test mode.)

- [ ] **Step 6: Commit**

```bash
git add playwright.config.ts e2e/ package.json pnpm-lock.yaml
git commit -m "test: Playwright setup + smoke E2E tests (dashboard, chat, console errors)"
```

---

### Task 24: GitHub Actions CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create CI workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck

  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test

  build:
    runs-on: ubuntu-latest
    needs: [typecheck]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build

  e2e:
    runs-on: ubuntu-latest
    needs: [build]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build  # Re-build needed because build job artifacts are not shared between jobs
      - run: npx playwright install --with-deps chromium
      - run: pnpm test:e2e
```

Note: The `needs: [build]` ensures the build job passed first (gate), but we re-run `pnpm build` in e2e because GitHub Actions jobs don't share filesystems. Alternative: use artifact upload/download to avoid double-build, but the simplicity tradeoff is acceptable.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions workflow - typecheck, unit tests, build, E2E"
```

---

## Task Dependency Graph

```
Phase 1 (Foundation):
  Task 1 (shadcn components)
  Task 2 (theme reconciliation) ← depends on Task 1
  Task 3 (React Query setup)
  Task 4 (query keys) ← depends on Task 3
  Task 5 (query hooks) ← depends on Task 4
  Task 6 (WS invalidation) ← depends on Task 5

Phase 2 (Chat): all depend on Phase 1
  Task 7 (toolbar fix)
  Task 8 (enhanced sidebar)
  Task 9 (tab bar) ← depends on Task 8
  Task 10 (extract ChatPane) ← depends on Task 9
  Task 11 (split view) ← depends on Task 10

Phase 3 (Navigation): depends on Phase 1, parallel with Phase 2
  Task 12 (breadcrumbs)
  Task 13 (command palette) ← depends on Task 5 (React Query hooks)

Phase 4 (New Capabilities): depends on Phases 1-2
  Task 14 (goals backend)
  Task 15 (goals frontend) ← depends on Task 14
  Task 16 (costs backend)
  Task 17 (budget backend) ← depends on Task 16
  Task 18 (costs frontend) ← depends on Tasks 16-17

Phase 5 (Testing): depends on Phases 1-4
  Task 19 (vitest backend)
  Task 20 (vitest frontend)
  Task 21 (turborepo test task) ← depends on Tasks 19-20
  Task 22 (mock engine)
  Task 23 (playwright + smoke) ← depends on Tasks 21-22
  Task 24 (GitHub Actions CI) ← depends on Task 23
```

## Parallelization Opportunities

- **Tasks 1-2** (shadcn) and **Tasks 3-6** (React Query) can be worked on in parallel
- **Phase 2** (Tasks 7-11) and **Phase 3** (Tasks 12-13) can be parallelized after Phase 1
- **Tasks 14-15** (goals) and **Tasks 16-18** (costs) can be parallelized within Phase 4
- **Tasks 19-20** (vitest setup) can be parallelized
