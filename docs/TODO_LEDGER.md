# TODO Ledger

This is the authoritative active Cuttlefish backlog for this checkout. Closed
defects and completed TODOs are retained, with their evidence, in
[TODO_HISTORY.md](TODO_HISTORY.md); they do not remain in this active table.

| ID | Status | Priority | Area | Item | Source | Opened | Last Evidence | Exit Criteria |
|---|---|---|---|---|---|---|---|---|
| SB-CUT-001 | in-progress | P3 | frontend-ux | Replace Rooms/Focused/All with project/session Team navigation and a Management lane while preserving session transport and authority boundaries. | `packages/web/src/components/chat/project-session-tree.ts`; `packages/web/src/components/chat/chat-sidebar.tsx`; `.giles/feature-ledger/giles-ledger-0022-sb-cut-001-collaboration-prototype.md` | 2026-07-20 | 2026-07-21: Team/Management lane control and recursive root-session project trees implemented with focused typecheck and 25 regression tests passing. | Complete the accepted later gates: project/management feed contracts and persistence, structured routing and authority scopes, durable URL/inspector behavior, atomic project-tree deletion, hostile communication/authorization audits, end-to-end coverage, and final release evidence. |
