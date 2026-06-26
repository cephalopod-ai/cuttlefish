# ICI-424: Linear-style Keyboard Shortcuts - Design Spec

## Overview

Add a centralized keyboard shortcut system to the Cuttlefish web dashboard chat page, with a Linear-style hint overlay. All shortcuts go through a single registry that handles event binding, input-field safety, and modal detection.

## Architecture

```
hooks/use-keyboard-shortcuts.ts     - Core hook: shortcut registry + keydown listener + safety guards
components/chat/shortcut-overlay.tsx - Hint overlay panel (bottom-right, toggled with ?)
app/chat/page.tsx                   - Wires shortcuts to page actions, renders overlay
```

### Why a hook (not Context/Provider)

All shortcuts live on the chat page. There's no need for dynamic registration from multiple components. A single hook with a static registry array is the simplest solution. The overlay component receives the registry as a prop and maps over it to render hints.

## Shortcut Registry

### Data Model

```typescript
interface ShortcutDef {
  key: string                                    // KeyboardEvent.key value (lowercase for letters)
  modifiers?: ('meta' | 'shift' | 'alt')[]       // Required modifier keys
  category: 'Navigation' | 'Actions' | 'Help'
  description: string                            // Shown in overlay
  action: () => void
  enabled?: boolean                              // Defaults to true; false hides from overlay + skips
}
```

### Bindings

| Key | Modifiers | Action | Category |
|-----|-----------|--------|----------|
| `n` | - | New chat (`handleNewChat`) | Actions |
| `j` | - | Select next session in sidebar (wraps) | Navigation |
| `k` | - | Select previous session in sidebar (wraps) | Navigation |
| `e` | - | Cycle to next employee group in sidebar (wraps) | Navigation |
| `Backspace` | - | Open delete confirmation dialog | Actions |
| `Delete` | - | Open delete confirmation dialog | Actions |
| `c` | - | Copy chat messages to clipboard + show toast | Actions |
| `Escape` | - | Close overlay / close modals | Navigation |
| `/` | - | Focus sidebar search input (via `id="chat-search"`) | Actions |
| `?` | - | Toggle shortcut hints overlay | Help |
| `w` | `meta` | Close current tab | Actions |
| `[` | `meta`, `shift` | Previous tab | Navigation |
| `]` | `meta`, `shift` | Next tab | Navigation |
| `1`–`9` | `meta`, `alt` | Jump to tab 1–9 | Navigation |

### Key Matching Logic

```
function matches(e: KeyboardEvent, shortcut: ShortcutDef): boolean
  1. Compare e.key (case-insensitive for letters) to shortcut.key
     - For '?': match e.key === '?' directly (Shift is implicit, not a modifier)
  2. If shortcut has modifiers, ALL must be pressed (metaKey, shiftKey, altKey)
     and no extra modifiers beyond those listed
  3. If shortcut has NO modifiers, NONE of meta/ctrl/alt must be pressed
     Shift check is skipped for keys where e.key already encodes the shift
     (e.g., '?' is Shift+/ but we match on e.key === '?')
  4. Call e.preventDefault() after a match to prevent browser defaults
     (e.g., Backspace triggering back-navigation, / typing into inputs)
```

## Safety Guards

### Input Guard

If `document.activeElement` matches `input`, `textarea`, or `[contenteditable]`:
- **Block** all non-modifier shortcuts (single-key like N, J, K, etc.)
- **Allow** modifier shortcuts (Cmd+W, Cmd+Shift+[, etc.) - these don't conflict with typing
- **Exception**: `Escape` always fires (to blur the input)

### Modal Guard

Use React state (`isModalOpen`) derived from existing dialog state (e.g., `confirmDelete`) rather than DOM querying. The chat page already tracks `confirmDelete` state for the delete dialog. Any future dialogs should also contribute to this flag. When `isModalOpen` is true:
- **Block** all shortcuts except `Escape`
- `Escape` closes the modal (already handled by Radix Dialog)

### Cleanup

The hook registers one `keydown` listener on `window` and removes it on unmount.

## J/K Session Navigation

The chat page needs a flat ordered list of session IDs matching the sidebar's display order.

### Avoiding ordering duplication

The sidebar has complex ordering logic (pinned vs unpinned, employee grouping, cron filtering). Instead of duplicating it, the sidebar will expose its computed flat order via a new callback prop:

```typescript
onOrderComputed?: (sessionIds: string[]) => void
```

The sidebar calls this whenever its rendered order changes. The chat page stores this list in a ref and uses it for J/K navigation.

### Navigation logic

1. On `J`: find current `selectedId` index in the flat list, select `index + 1` (wrap to 0)
2. On `K`: find current `selectedId` index, select `index - 1` (wrap to last)
3. If no session selected, J selects first, K selects last
4. Call `handleSelect(id)` which already handles tab opening and mobile view switching

## E Employee Cycling

The sidebar will also expose a computed employee order via a new callback prop:

```typescript
onEmployeeOrderComputed?: (employeeNames: string[]) => void
```

This includes the "direct" group (portal slug name) as an entry if direct sessions exist.

1. From the flat session list, group by employee
2. Find which employee owns the currently selected session
3. Select the first session of the next employee in the order (wraps around)
4. If no session selected, select first session of first employee
5. Direct sessions (no employee) are treated as a group using the portal slug name

## Copy Chat (C)

Messages are local state inside ChatPane and not accessible from the page component. Fetch from the API instead:

1. `GET /api/sessions/{selectedId}` returns the session with messages
2. Format as plain text: `[role]: message content` per line
3. Copy to clipboard via `navigator.clipboard.writeText()`
4. Show toast notification: "Chat copied to clipboard" (use existing notification context)
5. No-op if no session selected

## Shortcut Overlay Component

### Trigger
- `?` key toggles visibility
- Clicking outside dismisses it
- `Escape` dismisses it

### Layout
- Fixed position, bottom-right corner (`bottom-4 right-4`)
- `z-40` (below dialogs at z-50, above normal content)
- Width: `280px`
- Semi-transparent dark background: `bg-[var(--material-thick)]` with `backdrop-blur-xl`
- Border: `border border-border`
- Border radius: `rounded-[var(--radius-lg)]`
- Shadow: `shadow-[var(--shadow-overlay)]`

### Content Structure
```
┌─────────────────────────────────┐
│  Keyboard Shortcuts         ✕   │
│─────────────────────────────────│
│  Navigation                     │
│  ┌───┐                          │
│  │ J │  Next session            │
│  └───┘                          │
│  ┌───┐                          │
│  │ K │  Previous session        │
│  └───┘                          │
│  ...                            │
│                                 │
│  Actions                        │
│  ┌───┐                          │
│  │ N │  New chat                │
│  └───┘                          │
│  ...                            │
│                                 │
│  Help                           │
│  ┌───┐                          │
│  │ ? │  Toggle this overlay     │
│  └───┘                          │
└─────────────────────────────────┘
```

### Key Badge Styling
- Inline-flex, min-width 24px, centered
- `bg-[var(--fill-tertiary)]` background
- `rounded-[var(--radius-sm)]` corners
- `text-xs font-medium font-mono`
- Modifier keys displayed as symbols: `⌘` for Cmd, `⇧` for Shift, `⌥` for Alt

### Animation
- Fade in using CSS: `animate-fade-in` (existing keyframe, kebab-case)
- On close: set a closing state, apply `opacity-0` transition, then remove from DOM after 150ms

### Accessibility
- `role="complementary"` with `aria-label="Keyboard shortcuts"`
- Key badges are presentational (no interactive role needed)

### Click-outside dismiss
- Use a `useEffect` with `mousedown` listener on `document`
- If click target is outside the overlay ref, close it

## Integration Plan

### chat/page.tsx Changes
1. Remove existing `useEffect` keyboard handler (lines 268-290)
2. Add `useKeyboardShortcuts(shortcuts)` call with full registry
3. Add state: `showShortcutOverlay`
4. Render `<ShortcutOverlay>` component
5. Add J/K/E navigation using a computed flat session list
6. Wire C to copy, Delete to confirm dialog, N to new chat, / to search focus

### ChatPane Changes
- No changes needed. Copy action fetches messages via API.

### ChatSidebar Changes
- Add `id="chat-search"` to the search input element (for `/` shortcut focus)
- Add `onOrderComputed` callback prop - called with flat session ID list whenever render order changes
- Add `onEmployeeOrderComputed` callback prop - called with employee name list in display order

### Safety: No-op conditions
- `Backspace`/`Delete`: no-op when `selectedId` is null (set `enabled: false` dynamically)
- `C`: no-op when `selectedId` is null
- `J`/`K`: if no session list or empty, no-op

## Testing Strategy

### Unit Tests (hooks/__tests__/use-keyboard-shortcuts.test.ts)

1. **Key matching**: Verify correct shortcuts fire for correct key combos
2. **Input guard**: Shortcuts blocked when activeElement is input/textarea
3. **Modal guard**: Only Escape fires when dialog is open
4. **Modifier matching**: Meta+W fires, plain W does not (and vice versa)
5. **Enabled flag**: Disabled shortcuts don't fire
6. **Cleanup**: Listener removed on unmount

### Component Tests (components/chat/__tests__/shortcut-overlay.test.ts)

1. **Renders shortcuts grouped by category**
2. **Displays key badges with correct labels**
3. **Shows modifier symbols (⌘, ⇧, ⌥)**
4. **Hides disabled shortcuts**

### Integration (in chat page tests if they exist)

1. **J/K navigates sessions with wrap-around**
2. **E cycles employees with wrap-around**
3. **N triggers new chat**
4. **? toggles overlay**
5. **Delete opens confirmation dialog**

## Non-Goals

- No shortcut customization/rebinding
- No shortcut conflicts resolution system
- No shortcuts outside the chat page
- No key sequence support (e.g., `g then i`)
