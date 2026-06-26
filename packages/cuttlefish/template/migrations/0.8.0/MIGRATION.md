# Migration: 0.8.0 (Gemini CLI, Telegram, Keyboard Shortcuts, Session Rename)

## Summary

Major release adding a third AI engine (Gemini CLI), Telegram connector, keyboard shortcuts, inline session rename, employee picker, and numerous web dashboard improvements.

## Template files changed

None. All changes are gateway code, web dashboard, and runtime improvements.

## Version bump

Update `cuttlefish.version` in `config.yaml` from `"0.7.8"` to `"0.8.0"`.

## New features

### Gemini CLI Engine
- Third engine alongside Claude Code and Codex
- Full streaming support, session resume, process management
- Configure via `engines.gemini.enabled: true` in `config.yaml`
- Requires `gemini` CLI installed (`npm install -g @anthropic-ai/gemini-cli` or equivalent)

### Telegram Connector
- Polling-based bot using `node-telegram-bot-api`
- User allowlist (`allowFrom` config)
- Markdown-to-Telegram format conversion
- Configure via `connectors.telegram` in `config.yaml`

### Keyboard Shortcuts (web)
- Linear-style shortcut overlay (press `?` to see all)
- `J`/`K` to navigate sessions, `/` to focus search, `N` for new chat
- Shortcut hints displayed inline in the UI

### Employee Picker (web)
- Grouped, searchable employee picker when starting new chats
- Vertical layout organized by department

### Session Rename (web)
- Inline rename via right-click context menu or hover menu
- Cross-tab sync via WebSocket `session:updated` event
- Backend validation (type check, trim, non-empty, 200-char max)

### alwaysNotify Per-Employee
- `alwaysNotify` field in employee YAML
- `PATCH /api/org/employees/:name` endpoint to toggle from dashboard
- Suppresses notification for quiet employees

### Other improvements
- Auto-focus chat input on new chat
- Chat auto-scroll fix — no longer interrupts history reading
- `cuttlefish --version` reads from package.json (no more stale version)
- `cuttlefish migrate` fix for `--cwd` flag on Node.js
- Mobile zoom prevention on input focus
- Sidebar delete navigation and tab switching fixes

## Optional config additions

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `engines.gemini.enabled` | boolean | `false` | Enable Gemini CLI engine |
| `engines.gemini.model` | string | `"gemini-2.5-pro"` | Default Gemini model |
| `connectors.telegram.botToken` | string | _(unset)_ | Telegram bot token |
| `connectors.telegram.allowFrom` | string[] | _(unset)_ | Allowed Telegram usernames |

## Merge instructions

1. **Config**: Update `cuttlefish.version` to `"0.8.0"`. Optionally add Gemini/Telegram config.
2. **No template file changes** — nothing to copy or merge.
3. **Database**: Schema changes are handled automatically on gateway start.

## Files

No files directory — this migration is version-stamp only.
