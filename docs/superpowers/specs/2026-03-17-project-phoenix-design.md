# Project Phoenix: Cuttlefish Dashboard Overhaul

**Date**: 2026-03-17
**Status**: Draft
**Scope**: Full web dashboard modernization - UI framework, chat UX, navigation, goals, costs, testing

## Background

The Cuttlefish web dashboard (`packages/web`) was recently modified by an external contributor. Several UX regressions exist in the chat interface (collapsed sidebar without expand, toolbar notification/more-button conflicts). Separately, a competitive analysis against Paperclip (github.com/paperclipai/paperclip) revealed that Cuttlefish's UI would benefit from adopting several of Paperclip's patterns: shadcn/ui component library, cmdk command palette, TanStack React Query, breadcrumb navigation, and dark/light mode.

This spec defines a 5-phase overhaul that modernizes the dashboard while fixing current issues and adding new capabilities.

## Phasing Strategy

Each phase produces a working, shippable state. Phases 2 and 3 both depend on Phase 1 but are independent of each other - they can be parallelized.

| Phase | Name | Depends On | Scope |
|-------|------|------------|-------|
| 1 | Foundation | - | shadcn/ui completion + TanStack Query + theme reconciliation |
| 2 | Chat Overhaul | Phase 1 | Tabs + split view + sidebar + toolbar |
| 3 | Command Palette + Navigation | Phase 1 | cmdk upgrade + breadcrumbs |
| 4 | New Capabilities | Phases 1-2 | Goal hierarchy + cost budgets |
| 5 | Testing + CI | Phases 1-4 | Vitest + Playwright + GitHub Actions |

> **Note**: Phases 2 and 3 have no mutual dependency and can be worked on in parallel after Phase 1 completes.

---

## Phase 1: Foundation

### 1.1 shadcn/ui Completion

**Goal**: Complete the shadcn/ui migration already started. Install missing components, migrate remaining hand-rolled wrappers and inline styles to Tailwind-first patterns.

**Current state**: shadcn/ui is already partially initialized. `components.json` exists with New York style configured. Nine components are already installed: `badge`, `button`, `card`, `dialog`, `scroll-area`, `separator`, `skeleton`, `tabs`, `tooltip`. The `button` component has custom variants matching the project's design system. However, many pages still use hand-rolled Radix wrappers and inline `style={{}}` props.

**Target state**: All UI primitives come from shadcn/ui. Styling is Tailwind-first with CSS variables for theming. No more inline styles except for truly dynamic values.

**Components already installed** (do NOT overwrite - these have custom styling):
- Badge, Button, Card, Dialog, ScrollArea, Separator, Skeleton, Tabs, Tooltip

**Components to install** (new):
- Popover, Select, Input, Textarea, DropdownMenu
- Sheet (for mobile sidebar), ContextMenu, Toggle, ToggleGroup
- Alert, AlertDialog (for confirmations)
- Command (cmdk wrapper - needed for Phase 3)

**Migration strategy**:
1. Do NOT re-run `npx shadcn@latest init` - `components.json` already exists and is configured correctly
2. Install new components via `npx shadcn@latest add <component>` (one-by-one)
3. For each page, replace remaining hand-rolled components with shadcn equivalents
4. Migrate inline `style={{}}` to Tailwind utility classes page-by-page
5. Keep Apple SF Pro Display font stack - override shadcn's default font
6. Preserve existing Apple HIG design token names where they don't conflict

**Tailwind v4 compatibility note**: The project uses Tailwind CSS v4 with `@theme` directive and `@tailwindcss/postcss` plugin. Design tokens are defined in `globals.css` via `@theme {}` blocks, not in `tailwind.config.ts`. The shadcn CLI may need `--tailwind v4` flag or manual post-install adjustments to generated components. Verify each new component works with the v4 `@theme` approach.

**CSS architecture**:
- `globals.css` already defines CSS variables via `@theme` blocks - extend, don't replace
- Components use Tailwind utilities referencing CSS variables
- No more inline `style={{}}` except for truly dynamic values (stream positions, drag coordinates)
- Animation keyframes stay in globals.css (move inline `<style>` blocks to globals.css)

### 1.2 TanStack React Query

**Goal**: Replace all raw `fetch` + `useEffect` + `useState` data fetching with TanStack React Query for caching, deduplication, background refetching, and loading/error states.

**Query key structure** (`lib/queryKeys.ts`):
```typescript
export const queryKeys = {
  sessions: {
    all: ['sessions'] as const,
    detail: (id: string) => ['sessions', id] as const,
    children: (id: string) => ['sessions', id, 'children'] as const,
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
    summary: ['costs', 'summary'] as const,
    byEmployee: ['costs', 'by-employee'] as const,
  },
  goals: {
    all: ['goals'] as const,
    detail: (id: string) => ['goals', id] as const,
  },
  skills: {
    all: ['skills'] as const,
  },
  config: ['config'] as const,
  status: ['status'] as const,
}
```

**Query hooks** (`hooks/`):
- `useSessions()` - list with auto-refetch
- `useSession(id)` - single session detail
- `useEmployees()` - org roster
- `useCronJobs()` - cron list
- `useCosts()` - cost summary
- `useGoals()` - goal tree
- `useSkills()` - installed skills
- `useConfig()` - gateway config
- `useStatus()` - gateway health

**WebSocket + React Query integration**:
- WebSocket stays for real-time streaming (session deltas, live events)
- Create a dedicated `useQueryInvalidation()` hook that subscribes to the existing `useGateway()` event stream
- This hook lives in `client-providers.tsx` (mounted once at app root)
- Invalidation mapping (debounced at 500ms to prevent storms from rapid WS events):
  - `session:completed` → invalidate `queryKeys.sessions.all` + `queryKeys.sessions.detail(id)` + `queryKeys.costs.summary`
  - `session:started` → invalidate `queryKeys.sessions.all`
  - `activity` → invalidate relevant query based on event type
- This gives us: instant streaming via WS + consistent data via Query cache
- The existing `useGateway()` hook is preserved as-is - the invalidation hook is a consumer, not a replacement

**Provider setup** (add to `client-providers.tsx` - the existing client component wrapper):
```typescript
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,      // 30s before refetch
      gcTime: 5 * 60_000,     // 5min garbage collection
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
})
```

**Important**: The project uses Next.js App Router with `output: "export"` (static export). There is no `_app.tsx` - the app wraps in `client-providers.tsx`. All proposed features must work client-side only. Use `useRouter()` from `next/navigation` (NOT `useNavigate()` which doesn't exist in Next.js).

### 1.3 Theme System Reconciliation

**Goal**: Reconcile the existing 5-theme system with shadcn/ui's dark mode conventions. Ensure all themes render correctly with new shadcn components.

**Current state**: A fully functional theme system already exists:
- `lib/themes.ts` defines `ThemeId = 'dark' | 'glass' | 'color' | 'light' | 'system'`
- `providers.tsx` exports `ThemeProvider` with `useTheme()` hook
- Themes applied via `data-theme` attribute on `<html>` (NOT `.dark` class)
- `globals.css` has full CSS variable palettes for all 5 themes
- Persisted to `localStorage` key `cuttlefish-theme`
- System theme resolves OS preference to dark/light

**Conflict**: shadcn/ui components use Tailwind's `dark:` prefix which expects a `.dark` class on `<html>`. The current system uses `data-theme` attribute instead.

**Resolution strategy**:
1. Configure Tailwind v4 dark mode selector to match `[data-theme="dark"]`, `[data-theme="glass"]`, and `[data-theme="color"]` (all three are dark-background themes)
2. In `globals.css`, add: `@custom-variant dark (&:where([data-theme="dark"], [data-theme="glass"], [data-theme="color"]) *)` (Tailwind v4 syntax)
3. This makes shadcn's `dark:` utilities work with the existing `data-theme` system
4. Keep all 5 themes - do NOT reduce to just dark/light
5. Verify each shadcn component renders correctly in all 5 themes

**Existing toggle**: The settings page already has theme selection. No new toggle needed in sidebar - just verify it works with the reconciled system.

---

## Phase 2: Chat Overhaul

### 2.1 Enhanced Sidebar

**Goal**: Make the session sidebar rich enough for quick triage without opening sessions.

**Layout** (280px wide, collapsible):
```
┌─────────────────────┐
│ 🔍 Search sessions  │
│ [+ New Chat]        │
├─────────────────────┤
│ 📌 Pinned           │
│  ├ Session title... │
│  └ Session title... │
├─────────────────────┤
│ ▼ content-lead (3)   │  ← expandable
│  │ 🟢 Latest msg... │  ← preview
│  │    2 min ago     │
│  ├ 🔵 Running task  │
│  │    just now      │
│  └ ⚪ Old session   │
│      yesterday      │
│                     │
│ ▶ ops-lead (1)     │  ← collapsed
│ ▶ datalab-lead (2)  │
│                     │
│ 🤖 Direct (5)       │  ← Jimbo sessions
│  ├ Session title... │
│  └ Session title... │
├─────────────────────┤
│ ▶ ⏰ Scheduled (12) │  ← cron, collapsed
└─────────────────────┘
```

**Employee entry (collapsed)**:
- Avatar emoji (from org YAML) + employee display name
- Department label (muted)
- Session count badge
- Unread count badge (accent color, only if > 0)
- Status dot: running (blue pulse), error (red), unread (green), idle (gray)
- Last message timestamp
- Hover: pin button, context menu trigger

**Employee entry (expanded)** - shows up to 5 latest sessions:
- Each session: status dot + title (or "Untitled") + timestamp
- Last message preview (1 line, truncated)
- Click session → opens in active tab/pane
- "Show all" link if > 5 sessions

**Context menu** (right-click, shadcn ContextMenu):
- Open in new tab
- Open in split pane
- Pin / Unpin
- Mark all as read
- Delete session / Delete all for employee

**Search**: Filters by employee name, session title, and message content (debounced, 300ms).

**Persistence**: Expanded/collapsed state, pinned sessions, read state - all localStorage.

### 2.2 Tab Bar

**Goal**: Instant switching between open conversations without losing scroll position or draft messages.

**Layout** (between header and chat area, 36px height):
```
┌──────────────────────────────────────────────────┐
│ [🟢 content-lead ×] [🔵 ops-lead ×] [+ New]    │
└──────────────────────────────────────────────────┘
```

**Tab anatomy**:
- Status dot (4px, color-coded)
- Employee avatar emoji or session icon (16px)
- Session title or employee name (truncated to ~120px)
- Close button (×, 14px, visible on hover or active)
- Active tab: accent bottom border (2px), slightly lighter background
- Unread tab: bold text + unread dot

**Behavior**:
- Click tab → switch to that session (preserves scroll position per tab)
- Middle-click or click × → close tab
- `Cmd+W` → close active tab
- `Cmd+Shift+[` / `Cmd+Shift+]` → previous/next tab
- `Cmd+Alt+1` through `Cmd+Alt+9` → jump to tab by position (avoids browser tab shortcut conflicts)
- Tabs overflow → horizontal scroll with fade edges, or show "N more" dropdown
- Max 12 open tabs (configurable)
- Draggable to reorder

**State persistence**: Open tabs + active tab saved to localStorage key `cuttlefish-chat-tabs`. Restored on page load.

**Draft persistence**: Unsent message text per tab saved to localStorage. Restored when switching back to a tab.

### 2.3 Split View

**Goal**: Active multitasking - send messages to multiple employees simultaneously, watch parallel work streams.

**Modes**: Single (default) | Dual | Triple

**Layout (dual)**:
```
┌─────────────────────┬─────────────────────┐
│ Tab: content-lead    │ Tab: ops-lead      │
├─────────────────────┼─────────────────────┤
│                     │                     │
│  Chat messages      │  Chat messages      │
│                     │                     │
│                     │                     │
├─────────────────────┼─────────────────────┤
│ [Message input]     │ [Message input]     │
└─────────────────────┴─────────────────────┘
```

**Layout (triple)**:
```
┌───────────────┬───────────────┬───────────────┐
│ Pane 1        │ Pane 2        │ Pane 3        │
│ (full chat)   │ (full chat)   │ (full chat)   │
└───────────────┴───────────────┴───────────────┘
```

**Each pane**:
- Full chat view: messages + streaming + input box
- Own tab assignment (select which session to show)
- Own scroll position
- Active pane indicated by subtle accent border on focus
- Click anywhere in pane to focus it

**Controls**:
- Split toggle in toolbar: icons showing 1-pane / 2-pane / 3-pane layout
- `Cmd+\` → cycle split modes
- `Cmd+Alt+1/2/3` → focus pane (same shortcut family as tab switching - in split mode, focuses pane instead of switching tab)
- Drag divider between panes to resize (min 300px per pane)
- On window resize below minimum, auto-collapse to fewer panes

**Tab assignment**: Each pane picks from the open tabs. Sidebar click or tab click opens in the focused pane.

**Mobile**: Split view disabled. Falls back to single pane + tab bar.

### 2.4 Toolbar Fix

**Goal**: Clean, non-conflicting header with consistent button sizing and spacing.

**Current problems**:
- NotificationBell is `position: fixed` outside the chat page (in PageLayout), colliding with chat's own header buttons
- More menu and notification bell compete for top-right space
- z-index chaos (bell z-60, menus z-100)

**New header layout** (48px height, consistent across all pages):
```
┌──────────────────────────────────────────────────────────┐
│ [☰] Breadcrumb Trail                    [⊞] [🔔] [···] │
│  ↑                                        ↑    ↑    ↑   │
│  mobile                                 split bell more  │
│  menu                                   toggle           │
└──────────────────────────────────────────────────────────┘
```

**Rules**:
- NotificationBell moves INTO the header (not position:fixed) - part of the button group
- All toolbar buttons: 32px × 32px, 8px gap between them
- Button group: `display: flex; align-items: center; gap: 8px`
- Dropdowns: `position: absolute` relative to their button, consistent z-index (z-50)
- No more z-index conflicts - single stacking context
- Mobile: bell in mobile header, split toggle hidden

**Chat-specific additions** (only on chat page):
- Split view toggle (left of bell)
- View mode toggle Chat/CLI (left of split toggle, only when session selected)

---

## Phase 3: Command Palette + Navigation

### 3.1 Command Palette (cmdk upgrade)

**Goal**: Upgrade the existing `GlobalSearch` component (`components/global-search.tsx`) to a full cmdk-powered command palette with actions, sessions, skills, and recent items.

**Current state**: `GlobalSearch` already exists with `Cmd+K` toggle, fuzzy search across pages/employees/cron jobs, keyboard navigation, and Apple HIG styling. It uses raw `fetch` + `useState` for data.

**Implementation**: Replace `GlobalSearch` internals with cmdk library + shadcn Command component. Keep the existing `Cmd+K` keybinding and modal pattern. Migrate data fetching to React Query hooks (from Phase 1).

**Sections**:

| Group | Items | Source | Action |
|-------|-------|--------|--------|
| Recent | Last 5 used items | localStorage | Navigate/execute |
| Actions | New Chat, New Chat with @employee, Trigger Cron, Toggle Theme | Static + dynamic | Execute |
| Pages | Dashboard, Chat, Org, Kanban, Cron, Costs, Logs, Sessions, Settings, Skills | Static | Navigate |
| Employees | All employees with dept + role | `useEmployees()` | Open chat tab |
| Sessions | Active sessions by title | `useSessions()` | Open in chat tab |
| Cron Jobs | All jobs by name | `useCronJobs()` | Navigate to cron |
| Skills | Installed skills | `useSkills()` | Execute in active chat |

**Search behavior**:
- Fuzzy match across item names + descriptions
- Instant results from React Query cache
- Empty state: "No results found"
- Loading state: skeleton items while fetching

**Keyboard**:
- `Cmd+K` → open palette
- Type to search
- `↑` / `↓` → navigate
- `Enter` → select
- `Escape` → close
- `Cmd+K` again while open → close

**Architecture**:
- `CommandPalette.tsx` component in `components/`
- Mounted in root layout (available on all pages)
- Uses `useNavigate()` for page navigation
- Dispatches custom events for actions (new chat, trigger cron)
- Tracks recent items in localStorage key `cuttlefish-command-recent`

### 3.2 Breadcrumb Navigation

**Goal**: Clear orientation - user always knows where they are and can navigate back.

**Implementation**:
- `BreadcrumbContext` provider wrapping all routes
- Each page calls `useBreadcrumbs()` on mount to set its trail
- Breadcrumb data: `Array<{ label: string, href?: string }>`

**Display rules**:
- Single breadcrumb → rendered as page title (text-lg, font-semibold)
- Multiple breadcrumbs → trail with `>` separators, clickable ancestors
- Last item is current page (not clickable)
- Breadcrumb bar is part of the toolbar (left side, after mobile menu button)

**Examples**:
- Dashboard → `Dashboard`
- Chat with employee → `Chat > content-lead`
- Chat with specific session → `Chat > content-lead > Blog Strategy`
- Cron job runs → `Cron > daily-report > Runs`
- Settings → `Settings`

**Dynamic titles**: `document.title` updates to match the deepest breadcrumb.

---

## Phase 4: New Capabilities

### 4.1 Goal Hierarchy

**Goal**: Tasks trace back to higher-level objectives. Provides alignment and prioritization context.

**Data model** (new SQLite table):
```sql
CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'not_started',  -- not_started | in_progress | at_risk | completed
  level TEXT DEFAULT 'company',        -- company | department | task
  parent_id TEXT REFERENCES goals(id),
  department TEXT,                      -- NULL for company-level
  owner TEXT,                           -- employee name
  progress INTEGER DEFAULT 0,          -- 0-100, auto-calculated from children
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

**API endpoints**:
- `GET /api/goals` - list all goals (flat, filterable by level/department/status)
- `GET /api/goals/tree` - full tree structure
- `POST /api/goals` - create goal
- `PUT /api/goals/:id` - update goal
- `DELETE /api/goals/:id` - delete (cascades to children)
- `GET /api/goals/:id/tasks` - kanban tasks linked to this goal

**UI** (`/goals` page):
- Tree view: company goals → department goals → linked tasks
- Each goal: title, status badge, progress bar, owner avatar, child count
- Expand/collapse per node
- Click goal → detail panel (right side) with description, linked tasks, edit form
- "New Goal" button → dialog with title, level, parent, department, owner
- Filter bar: by status, department, level

**Kanban integration**:
- Kanban boards are currently stored as JSON files (`board.json`) in each department's org directory (e.g., `~/.cuttlefish/org/content/board.json`)
- Board JSON format: `{ todo: Task[], in_progress: Task[], done: Task[] }` where each Task has `{ id, title, description, assignee, ... }`
- Add optional `goalId: string` field to the Task type
- When rendering kanban cards, display linked goal as small badge (goal title, truncated)
- Creating a card from a goal detail auto-links it
- The `/api/goals/:id/tasks` endpoint scans all department boards for tasks with matching `goalId`

### 4.2 Cost Tracking & Budgets

**Goal**: Working cost visibility + budget enforcement.

**Current state**: The frontend costs page exists but has no working backend API. Zero `/api/costs/*` or `/api/budgets/*` routes exist in `api.ts`. Cost data exists only as `total_cost` and `total_turns` columns on the sessions SQLite table (accumulated by `accumulateSessionCost()` after session completion). All cost aggregation endpoints need to be **created from scratch**.

**Create cost aggregation API** (backend - new routes in `api.ts`):
- `GET /api/costs/summary?period=day|week|month`
  - Aggregates `total_cost` from sessions table grouped by period
  - Returns: total spend, spend by employee, spend by department, spend by day
- `GET /api/costs/by-employee?period=month`
  - Groups sessions by employee, sums `total_cost`
  - Returns: per-employee breakdown with session count + total cost
- Ensure Claude Code CLI output is parsed correctly for cost data (JSON `result.cost_usd` field) and accumulated via existing `accumulateSessionCost()` mechanism

**Budget system** (new):

Config in `~/.cuttlefish/config.yaml`:
```yaml
budgets:
  global:
    monthly: 100  # USD
    action: warn  # warn | pause
  employees:
    content-lead:
      monthly: 30
      action: pause
    ops-lead:
      monthly: 20
      action: warn
```

New SQLite table:
```sql
CREATE TABLE budget_events (
  id TEXT PRIMARY KEY,
  employee TEXT,
  event_type TEXT,  -- 'warning' | 'paused' | 'resumed' | 'reset'
  amount REAL,
  limit_amount REAL,
  created_at TEXT DEFAULT (datetime('now'))
);
```

**Enforcement logic** (in session manager):
- Budget check happens in `SessionManager.route()` BEFORE calling `engine.run()` (not before `createSession()` - the session stub can exist, but execution is gated)
- Aggregation query: `SELECT SUM(total_cost) FROM sessions WHERE employee = ? AND created_at >= date('now', 'start of month')`
- At 80% of budget → emit `budget:warning` event (notification to user)
- At 100% with `action: pause` → refuse to run engine, set session status to `paused`, emit `budget:paused`
- At 100% with `action: warn` → allow but emit `budget:exceeded`
- Manual override: `POST /api/budgets/:employee/override` (allows one session past limit)

**Costs page** (fix + enhance):
- Summary cards: Total spend (this month), daily average, projected month-end
- Bar chart: daily spend over last 30 days
- Table: per-employee spend with budget progress bar, status (ok / warning / paused)
- Budget config editor: inline edit monthly limits per employee
- Budget event log: recent warnings, pauses, overrides
- API: `GET /api/budgets` (current state), `PUT /api/budgets` (update limits)

---

## Phase 5: Testing + CI

### 5.1 Vitest (Unit Tests)

**Backend** (`packages/cuttlefish`):
- `vitest.config.ts` - ESM mode, coverage reporter
- Test files: `src/**/*.test.ts`
- Key test targets:
  - API routes: mock HTTP requests, assert responses (using supertest or native fetch)
  - Session manager: queue logic, cost accumulation, employee routing
  - Cron scheduler: job registration, trigger, run logging
  - Config loader: YAML parsing, hot-reload simulation
  - Context builder: system prompt assembly from org + employee files
- Mocking: SQLite via in-memory database (`:memory:`), file system via `memfs` or temp dirs

**Frontend** (`packages/web`):
- `vitest.config.ts` - jsdom environment, React testing library
- Test files: `src/**/*.test.tsx`
- Key test targets:
  - Chat sidebar: rendering, filtering, expand/collapse, pin/unpin
  - Chat messages: markdown rendering, tool group collapse, streaming
  - Command palette: search, keyboard navigation, action execution
  - Tab bar: open/close/switch/reorder tabs
  - Theme toggle: dark/light/system switching
- Utilities: `@testing-library/react`, `@testing-library/user-event`

### 5.2 Playwright (E2E Tests)

**Config**: `playwright.config.ts` in monorepo root.

**Setup**: Start gateway in test mode (in-memory SQLite, fixed port, no Slack connector) via `globalSetup`. Engine calls must be mocked - create a `MockEngine` that returns canned responses with simulated streaming delays. Without this, chat E2E tests would require actual Claude Code execution (slow, expensive, flaky).

**Test suites** (`e2e/`):
- `smoke.spec.ts` - Dashboard loads, all nav links work, no console errors
- `chat.spec.ts` - Open chat, send message, see streaming response, session appears in sidebar
- `chat-tabs.spec.ts` - Open multiple tabs, switch between them, close tabs
- `chat-split.spec.ts` - Enable split view, assign sessions to panes
- `command-palette.spec.ts` - Open with Cmd+K, search, navigate, close
- `cron.spec.ts` - View jobs, manual trigger, view run history
- `org.spec.ts` - View employees, department boards
- `costs.spec.ts` - View cost summary, budget indicators
- `theme.spec.ts` - Toggle dark/light mode, persists on reload

**Assertion patterns**: Visual regression optional (screenshot comparison). Primary: DOM assertions + network request validation.

**Dependency versions** (must be compatible with React 19 + Tailwind v4 + Next.js 15):
- `@tanstack/react-query` v5.x (v5 required for React 19)
- `cmdk` v1.x
- `vitest` v3.x
- `@playwright/test` v1.x
- `@testing-library/react` v16.x (React 19 support)

**Turborepo integration**: Add `test` and `test:e2e` scripts to both `packages/cuttlefish/package.json` and `packages/web/package.json`. Update `turbo.json` pipeline to include `test` task. Update root `package.json` `test` script to run both packages (currently only runs `cuttlefish-cli`).

### 5.3 GitHub Actions CI

**Workflow** (`.github/workflows/ci.yml`):
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
      - run: pnpm build
      - run: npx playwright install --with-deps chromium
      - run: pnpm test:e2e
```

**Branch protection** (manual setup): Require CI pass before merge to main.

---

## File Impact Summary

### New files
- `packages/web/src/lib/queryKeys.ts` - React Query key factory
- `packages/web/src/lib/queryClient.ts` - QueryClient config
- `packages/web/src/hooks/use-sessions.ts` - session query hooks
- `packages/web/src/hooks/use-employees.ts` - org query hooks
- `packages/web/src/hooks/use-costs.ts` - cost query hooks
- `packages/web/src/hooks/use-goals.ts` - goal query hooks
- `packages/web/src/hooks/use-query-invalidation.ts` - WS → React Query bridge
- `packages/web/src/context/BreadcrumbContext.tsx` - navigation breadcrumbs
- `packages/web/src/components/BreadcrumbBar.tsx` - breadcrumb display
- `packages/web/src/components/chat/chat-tabs.tsx` - tab bar
- `packages/web/src/components/chat/chat-split.tsx` - split view container
- `packages/web/src/app/goals/page.tsx` - goals page
- `packages/cuttlefish/src/gateway/goals.ts` - goals API routes
- `packages/cuttlefish/src/gateway/costs.ts` - cost aggregation API routes (new from scratch)
- `packages/cuttlefish/src/gateway/budgets.ts` - budget API routes
- `packages/cuttlefish/src/engines/mock.ts` - mock engine for E2E tests
- `packages/cuttlefish/vitest.config.ts`
- `packages/web/vitest.config.ts`
- `playwright.config.ts`
- `e2e/` - E2E test directory
- `.github/workflows/ci.yml`

### Modified files (existing)
- `packages/web/components.json` - already exists, may need minor updates for new components
- `packages/web/src/app/globals.css` - add `@custom-variant dark` for shadcn compatibility, extend themes
- `packages/web/src/components/ui/*` - existing 9 shadcn components preserved, new ones added alongside
- `packages/web/src/app/chat/page.tsx` - tab + split view integration
- `packages/web/src/components/chat/chat-sidebar.tsx` - enhanced sidebar
- `packages/web/src/components/chat/chat-messages.tsx` - shadcn migration
- `packages/web/src/components/chat/chat-input.tsx` - shadcn migration
- `packages/web/src/components/page-layout.tsx` - toolbar fix, breadcrumbs, cmdk
- `packages/web/src/components/global-search.tsx` - replace internals with cmdk + React Query
- `packages/web/src/components/notifications/notification-bell.tsx` - move into header flow
- `packages/web/src/app/client-providers.tsx` - add QueryClientProvider + query invalidation hook
- `packages/web/src/app/providers.tsx` - existing ThemeProvider preserved, no changes needed
- `packages/web/src/lib/api.ts` - wrap with React Query
- `packages/web/package.json` - new dependencies
- `packages/cuttlefish/src/gateway/api.ts` - goals + budgets + cost aggregation routes
- `packages/cuttlefish/src/sessions/manager.ts` - budget enforcement before engine.run()
- `packages/cuttlefish/src/shared/types.ts` - goal + budget types
- `packages/cuttlefish/package.json` - vitest dependency
- `turbo.json` - add `test` pipeline task
- Root `package.json` - update test script to include both packages

### Deleted files
- None - all changes are additive or in-place replacements

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| shadcn/ui migration breaks existing pages | High | Migrate one page at a time, test manually between |
| React Query migration introduces stale data bugs | Medium | Keep WebSocket invalidation, add React Query devtools for debugging |
| Split view performance with 3 streaming sessions | Medium | Throttle re-renders per pane, use `React.memo` on message components |
| Inline style → Tailwind migration misses edge cases | Low | Visual regression testing with Playwright screenshots |
| Budget enforcement blocks legitimate work | Low | Always allow manual override, default to `warn` not `pause` |

## Success Criteria

- All existing pages render correctly in both dark and light mode
- Chat sidebar shows employee groups with expand/collapse and message previews
- User can have 3+ conversations open in tabs, switch instantly with keyboard
- Split view allows sending messages to 2-3 sessions simultaneously
- `Cmd+K` palette navigates to any page, employee, or session within 2 keystrokes
- Cost page shows accurate per-employee spend data
- Budget warnings fire at 80% threshold
- CI pipeline passes on all PRs: typecheck + unit tests + build + E2E
- No visual regressions on existing pages after migration
